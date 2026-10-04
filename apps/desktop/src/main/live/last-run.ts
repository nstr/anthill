/**
 * The run a workflow last had, after the live store has let it go (ANT-275).
 *
 * The live store keeps a settled run for a day and then drops it: it is a
 * working set, not a history. The launch window went on saying "Finished"
 * from the ending kept in `workflow-status.json`, while the editor's Live
 * session tab, which only asked the live store, said no session had ever run
 * the workflow. The journal of what that session did was still on disk, and
 * nothing could open it.
 *
 * This answers the tab. A record that kept its run hands it back as it was. An
 * older record has only the ending and the run id; the rest is rebuilt from
 * what outlived it — the journal says which tool ran and in which session, and
 * a handover's binding names the revision the run worked from, so the page
 * still draws the graph that ran rather than whatever is on the canvas now.
 *
 * Read only. Nothing here goes back into the live store, so a rebuilt run is
 * never observed again and never shown as live.
 */

import type { ObservationEvent, PendingRun } from "@anthill/live";
import type { Binding } from "@anthill/exchange-store";

import type { WorkflowStatus } from "./workflow-status.js";

export type LastRunSources = {
  /** The run's journal, oldest first. */
  events(runId: string): Promise<ObservationEvent[]>;
  /** The handover binding the run made, when it was a handover. */
  binding(workflowId: string, runId: string): Promise<Binding | undefined>;
};

export async function lastRun(
  workflowId: string,
  status: WorkflowStatus | undefined,
  sources: LastRunSources,
): Promise<PendingRun | undefined> {
  if (!status) return undefined;
  if (status.run) return status.run;

  const [events, binding] = await Promise.all([
    sources.events(status.runId).catch((): ObservationEvent[] => []),
    sources.binding(workflowId, status.runId).catch(() => undefined),
  ]);
  // Without a single event there is no session to show: the journal is the
  // page. That is also the run nobody ever claimed, which never had one.
  const first = events[0];
  if (!first) return undefined;
  const sessionId = [...events].reverse().find((event) => event.sessionId)?.sessionId;

  return {
    anthillRunId: status.runId,
    workflowId,
    promptVersion: "",
    selectedCli: first.cli,
    createdAt: binding?.at ?? first.at,
    expiresAt: status.at,
    correlationNonce: binding?.nonce ?? "",
    bootstrapPromptHash: "",
    state: status.state,
    lastObservedAt: status.at,
    closedAt: status.at,
    ...(sessionId ? { detectedSessionId: sessionId } : {}),
    ...(first.channel ? { evidenceChannel: first.channel } : {}),
    ...(binding?.digest
      ? {
          exchange: {
            revision: binding.revision,
            digest: binding.digest,
            ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
          },
        }
      : {}),
    ...(status.stopped ? { observationStoppedAt: status.at } : {}),
  };
}
