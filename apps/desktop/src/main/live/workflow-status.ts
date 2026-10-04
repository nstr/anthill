/**
 * How each workflow's last observed run ended, kept for as long as the workflow is.
 *
 * The launch window's status dot was read from the live run store, and that
 * store is a working set rather than a history: a settled run is dropped a day
 * after its last evidence, because keeping it open would mean Anthill claiming
 * to watch something it long ago stopped reading. The consequence nobody
 * intended is that every workflow turns grey twenty-four hours after its
 * session ends, and a machine that has not been used for a week looks like a
 * machine that has never been used (ANT-84).
 *
 * It looked like a reinstall erasing data, and it is worth being exact that it
 * was not: the application-data directory is pinned and survives the bundle
 * being replaced, with the agent library, the assistant threads, the recent
 * list and every observation journal intact. What was missing was never
 * written down in the first place.
 *
 * So this file is the part that was missing. It holds one small record per
 * workflow — how its last run ended, and when — written at the moment a run
 * settles, while the run still knows which workflow it belongs to. The
 * journals cannot answer this on their own: their events carry a run id and no
 * workflow id, so a journal without its run is a conversation with no way back
 * to the thing it was about.
 *
 * Three things it deliberately does not do:
 *
 * - **It is not the live store, and never contradicts it.** Anything currently
 *   being watched is read from there; this answers only for workflows with no
 *   live run left. One source per question.
 * - **It does not keep a history, only the last word.** A list of every run a
 *   workflow ever had is a feature with a screen attached; the dot needs one
 *   fact, and storing more than the question needs is how a small file becomes
 *   a thing nobody dares migrate.
 * - **It does not age out.** That is the whole point. A record goes when its
 *   workflow is taken off the recent list, and otherwise it stays.
 *
 * The last word includes the run itself, as it was when it settled (ANT-275).
 * The editor's Live session tab opens the finished session from it once the
 * live store has dropped the run, and a row saying "Finished" beside a tab
 * saying no session ever ran was two answers to one question.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LiveSessionState, PendingRun } from "@anthill/live";

/** Bumped when the file's shape changes. A version this one cannot read is ignored. */
export const WORKFLOW_STATUS_VERSION = 1;

/**
 * The states that are an ending, and so worth remembering.
 *
 * `completed` and `failed` are what the session recorded about itself.
 * `observation_lost` is Anthill's own admission that it stopped being able to
 * tell — which is a different thing from either, and is still the last true
 * thing known about that workflow.
 *
 * The transient states are not here on purpose. A run still waiting for a
 * session, or one being watched right now, is answered by the live store; a
 * remembered "waiting for a session" would outlive the waiting and become a
 * claim about the present that was never true.
 */
const ENDINGS: readonly LiveSessionState[] = ["completed", "failed", "observation_lost"];

export function isEnding(state: LiveSessionState): boolean {
  return ENDINGS.includes(state);
}

export type WorkflowStatus = {
  /** How the last observed run ended. Always one of `ENDINGS`. */
  state: LiveSessionState;
  /**
   * When it ended, as Anthill last had evidence — not when this was written.
   *
   * The distinction matters on the screen: "Finished · 8 Sep" is a claim about
   * the session, and the moment a record happened to be flushed is not.
   */
  at: string;
  /** The run it came from, so a record can be traced to its journal. */
  runId: string;
  /** The step the session last announced, when it announced one. */
  stepId?: string;
  /** The author stopped observing it, rather than Anthill losing it (ANT-191). */
  stopped?: boolean;
  /**
   * No session ever carried the copied prompt. Nothing started, so nothing
   * failed: shown as that, not as a failed session (ANT-212).
   */
  unclaimed?: boolean;
  /**
   * The run as it settled, so its session can still be opened after the live
   * store has let it go (ANT-275). Absent from records written before this
   * was kept; `lastRun` rebuilds what it can for those.
   */
  run?: PendingRun;
};

type Stored = { version: number; workflows: Record<string, WorkflowStatus> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read the file into records this version understands.
 *
 * Record by record: one entry that cannot be read costs that workflow's dot
 * and nothing else. Resetting the library because a single line is malformed
 * is the failure this bug is about, arriving from a different direction.
 */
function parse(text: string): Record<string, WorkflowStatus> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(value) || value.version !== WORKFLOW_STATUS_VERSION) return {};
  if (!isRecord(value.workflows)) return {};

  const workflows: Record<string, WorkflowStatus> = {};
  for (const [workflowId, entry] of Object.entries(value.workflows)) {
    if (!isRecord(entry)) continue;
    const state = str(entry.state) as LiveSessionState | undefined;
    const at = str(entry.at);
    const runId = str(entry.runId);
    if (!state || !at || !runId) continue;
    if (!isEnding(state)) continue;
    if (Number.isNaN(Date.parse(at))) continue;
    const stepId = str(entry.stepId);
    const run = storedRun(entry.run, runId, workflowId);
    workflows[workflowId] = {
      state,
      at,
      runId,
      ...(stepId ? { stepId } : {}),
      ...(entry.stopped === true ? { stopped: true } : {}),
      ...(entry.unclaimed === true ? { unclaimed: true } : {}),
      ...(run ? { run } : {}),
    };
  }
  return workflows;
}

/**
 * The kept run, when it is one and it is this record's.
 *
 * Checked only as far as the page needs to trust it: a run that names another
 * id, another workflow or a state that is no ending is dropped, and the record
 * falls back to what `lastRun` can rebuild. The dot never depended on it.
 */
function storedRun(value: unknown, runId: string, workflowId: string): PendingRun | undefined {
  if (!isRecord(value)) return undefined;
  if (value.anthillRunId !== runId || value.workflowId !== workflowId) return undefined;
  const state = str(value.state) as LiveSessionState | undefined;
  if (!state || !isEnding(state)) return undefined;
  if (!str(value.selectedCli) || !str(value.createdAt)) return undefined;
  return value as unknown as PendingRun;
}

export class WorkflowStatusStore {
  private workflows?: Record<string, WorkflowStatus>;
  private loading?: Promise<Record<string, WorkflowStatus>>;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  constructor(private readonly path: string) {}

  /** Every remembered ending, by workflow id. */
  async all(): Promise<Record<string, WorkflowStatus>> {
    return { ...(await this.load()) };
  }

  /** The record a run left, and the workflow it is filed under. */
  async find(runId: string): Promise<{ workflowId: string; status: WorkflowStatus } | undefined> {
    const workflows = await this.load();
    for (const [workflowId, status] of Object.entries(workflows)) {
      if (status.runId === runId) return { workflowId, status };
    }
    return undefined;
  }

  /**
   * Write down how this run ended, if it ended and if it can be attributed.
   *
   * A run with no workflow id cannot be attributed to anything — it was copied
   * before ids travelled with a run, or from a workflow that had none — and a
   * record filed under nothing would be a record nobody could ever read.
   *
   * Later evidence wins, and only later evidence: runs are polled and settled
   * out of order often enough that a re-read of an old record must not
   * overwrite a newer ending with an older one.
   */
  async remember(run: PendingRun): Promise<void> {
    const workflowId = run.workflowId;
    if (!workflowId || !isEnding(run.state)) return;

    const at = run.lastObservedAt ?? run.closedAt ?? run.createdAt;
    if (!at || Number.isNaN(Date.parse(at))) return;

    const workflows = await this.load();
    const held = workflows[workflowId];
    if (held && Date.parse(held.at) > Date.parse(at)) return;

    workflows[workflowId] = {
      state: run.state,
      at,
      runId: run.anthillRunId,
      ...(run.observationStoppedAt ? { stopped: true } : {}),
      ...(run.state === "failed" && !run.detectedSessionId ? { unclaimed: true } : {}),
      // Whether it was put away in the launch window says nothing about the
      // session, and the tab opens it either way.
      run: withoutDismissal(run),
    };
    await this.flush();
  }

  /**
   * Forget one workflow's ending.
   *
   * Called when the workflow leaves the recent list, which is the only place
   * this is ever read from: a record for a file nobody lists is a record
   * nothing can ask about.
   */
  async forget(workflowId: string): Promise<void> {
    const workflows = await this.load();
    if (!(workflowId in workflows)) return;
    delete workflows[workflowId];
    await this.flush();
  }

  private load(): Promise<Record<string, WorkflowStatus>> {
    if (this.workflows) return Promise.resolve(this.workflows);
    this.loading ??= readFile(this.path, "utf8").then(
      (text) => (this.workflows = parse(text)),
      // No file yet, or one this process cannot read. An empty set of records
      // is the honest answer: grey dots, which is what today already does.
      () => (this.workflows = {}),
    );
    return this.loading;
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        version: WORKFLOW_STATUS_VERSION,
        workflows: this.workflows ?? {},
      } satisfies Stored,
      null,
      2,
    );
    this.writing = this.writing.then(() => this.persist(snapshot));
    await this.writing;
  }

  private async persist(snapshot: string): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      this.writeSeq += 1;
      const temp = `${this.path}.${process.pid}.${this.writeSeq}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.path);
    } catch {
      // A lost dot is better than taking the app down for it.
    }
  }
}

function withoutDismissal(run: PendingRun): PendingRun {
  const { dismissedAt: _dismissed, ...kept } = run;
  return kept;
}
