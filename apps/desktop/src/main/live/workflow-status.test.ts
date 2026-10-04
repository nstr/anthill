/**
 * The last thing known about a workflow, kept after the run is gone.
 *
 * ANT-84 was reported as a reinstall erasing history. It was not: the
 * application-data directory survives the bundle being replaced, and every
 * journal was still there. What was missing had never been written down — the
 * launch window read its dot from the live run store, which drops a settled
 * run a day after its last evidence, so every row turned grey a day after it
 * was last used.
 *
 * These hold the record that fixes that, and the two things it must not become:
 * a second opinion about what is live, and a file that resets a whole library
 * because one line in it is malformed.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";
import type { PendingRun } from "@anthill/live";

import {
  isEnding,
  WorkflowStatusStore,
  WORKFLOW_STATUS_VERSION,
} from "./workflow-status.js";

let dir = "";
let path = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anthill-status-"));
  path = join(dir, "workflow-status.json");
});

const RUN: PendingRun = {
  anthillRunId: "ANT-1",
  workflowId: "workflow-1",
  workflowName: "Implement and check",
  promptVersion: "1",
  selectedCli: "claude-code",
  createdAt: "2026-09-01T10:00:00.000Z",
  expiresAt: "2026-09-01T11:00:00.000Z",
  correlationNonce: "nonce",
  bootstrapPromptHash: "hash",
  state: "completed",
  lastObservedAt: "2026-09-01T10:40:00.000Z",
};

describe("an ending", () => {
  it("outlives the run, which is the whole point", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember(RUN);

    // A new store over the same file is the app being started again — days
    // later, with the run itself long since dropped from the live store.
    const later = await new WorkflowStatusStore(path).all();
    expect(later["workflow-1"]).toEqual({
      state: "completed",
      at: "2026-09-01T10:40:00.000Z",
      runId: "ANT-1",
      run: RUN,
    });
  });

  // ANT-275: the Live session tab opens the finished session from this.
  it("keeps the run as it settled, and can be found by its id", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember({ ...RUN, dismissedAt: "2026-09-01T12:00:00.000Z" });

    const later = new WorkflowStatusStore(path);
    expect((await later.all())["workflow-1"].run).toEqual(RUN);
    expect(await later.find("ANT-1")).toMatchObject({ workflowId: "workflow-1", status: { runId: "ANT-1" } });
    expect(await later.find("ANT-404")).toBeUndefined();
  });

  // ANT-212: a copied prompt no session ever carried did not fail.
  it("says when no session ever carried the copied prompt", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember({ ...RUN, state: "failed", workflowId: "never" });
    await store.remember({ ...RUN, state: "failed", workflowId: "broke", detectedSessionId: "sess-1" });
    const later = await new WorkflowStatusStore(path).all();
    expect(later["never"].unclaimed).toBe(true);
    expect(later["broke"].unclaimed).toBeUndefined();
  });

  it("is recorded for every way a run can end", async () => {
    const store = new WorkflowStatusStore(path);
    for (const [workflowId, state] of [
      ["w-done", "completed"],
      ["w-bad", "failed"],
      ["w-lost", "observation_lost"],
    ] as const) {
      await store.remember({ ...RUN, workflowId, state });
    }
    const all = await store.all();
    expect(Object.keys(all).sort()).toEqual(["w-bad", "w-done", "w-lost"]);
  });

  it("is not recorded for a run that has not ended", async () => {
    // The live store answers for these. A remembered "waiting for a session"
    // would outlive the waiting and become a claim about now that was never
    // true.
    const store = new WorkflowStatusStore(path);
    for (const state of ["pending_after_copy", "detected_live", "ambiguous_match", "idle"] as const) {
      await store.remember({ ...RUN, state });
    }
    expect(await store.all()).toEqual({});
  });

  it("is dated by the session's own last evidence, not by when it was written", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember(RUN);
    expect((await store.all())["workflow-1"].at).toBe(RUN.lastObservedAt);
  });

  it("falls back to what the run does know when it was never observed", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember({
      ...RUN,
      state: "failed",
      lastObservedAt: undefined,
      closedAt: "2026-09-01T10:31:00.000Z",
    });
    expect((await store.all())["workflow-1"].at).toBe("2026-09-01T10:31:00.000Z");
  });

  it("is kept per workflow, so one never speaks for another", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember(RUN);
    await store.remember({ ...RUN, workflowId: "workflow-2", state: "failed" });
    const all = await store.all();
    expect(all["workflow-1"].state).toBe("completed");
    expect(all["workflow-2"].state).toBe("failed");
  });

  it("cannot be filed for a run that does not know its workflow", async () => {
    // A record under no id is a record nothing could ever read back.
    const store = new WorkflowStatusStore(path);
    await store.remember({ ...RUN, workflowId: undefined });
    expect(await store.all()).toEqual({});
  });
});

describe("a later ending", () => {
  it("replaces an earlier one", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember(RUN);
    await store.remember({
      ...RUN,
      anthillRunId: "ANT-2",
      state: "failed",
      lastObservedAt: "2026-09-02T09:00:00.000Z",
    });
    expect((await store.all())["workflow-1"]).toMatchObject({ state: "failed", runId: "ANT-2" });
  });

  it("is not displaced by an older one arriving late", async () => {
    // Runs settle out of order often enough — a lost run looked at again, an
    // old record re-read — that the newest ending has to win on its own date.
    const store = new WorkflowStatusStore(path);
    await store.remember({ ...RUN, state: "failed", lastObservedAt: "2026-09-02T09:00:00.000Z" });
    await store.remember({ ...RUN, state: "completed", lastObservedAt: "2026-09-01T10:40:00.000Z" });
    expect((await store.all())["workflow-1"].state).toBe("failed");
  });
});

describe("the record", () => {
  it("goes when its workflow leaves the list that reads it", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember(RUN);
    await store.remember({ ...RUN, workflowId: "workflow-2" });
    await store.forget("workflow-1");
    expect(Object.keys(await store.all())).toEqual(["workflow-2"]);
  });

  it("is an empty set when the file cannot be read, not an error", async () => {
    await writeFile(path, "{ not json", "utf8");
    expect(await new WorkflowStatusStore(path).all()).toEqual({});
  });

  it("is an empty set when the envelope is a version this one does not speak", async () => {
    await writeFile(
      path,
      JSON.stringify({ version: WORKFLOW_STATUS_VERSION + 1, workflows: { "w-1": {} } }),
      "utf8",
    );
    expect(await new WorkflowStatusStore(path).all()).toEqual({});
  });

  it("reads a record from before the run was kept, and drops a kept run that is not its own", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: WORKFLOW_STATUS_VERSION,
        workflows: {
          older: { state: "completed", at: "2026-09-01T10:40:00.000Z", runId: "ANT-1" },
          stranger: {
            state: "completed",
            at: "2026-09-01T10:40:00.000Z",
            runId: "ANT-2",
            run: { ...RUN, anthillRunId: "ANT-9", workflowId: "stranger" },
          },
        },
      }),
      "utf8",
    );
    const all = await new WorkflowStatusStore(path).all();
    expect(all.older).toEqual({ state: "completed", at: "2026-09-01T10:40:00.000Z", runId: "ANT-1" });
    expect(all.stranger.runId).toBe("ANT-2");
    expect(all.stranger.run).toBeUndefined();
  });

  it("loses only the entry it cannot read", async () => {
    // The failure this bug is about, arriving from another direction: one bad
    // line must not grey out the whole library.
    await writeFile(
      path,
      JSON.stringify({
        version: WORKFLOW_STATUS_VERSION,
        workflows: {
          good: { state: "completed", at: "2026-09-01T10:40:00.000Z", runId: "ANT-1" },
          "no-date": { state: "completed", runId: "ANT-2" },
          "not-a-date": { state: "failed", at: "sometime", runId: "ANT-3" },
          "not-an-ending": { state: "detected_live", at: "2026-09-01T10:40:00.000Z", runId: "ANT-4" },
          rubbish: 7,
        },
      }),
      "utf8",
    );
    expect(Object.keys(await new WorkflowStatusStore(path).all())).toEqual(["good"]);
  });

  it("is handed back as a copy, so a caller cannot edit it in place", async () => {
    const store = new WorkflowStatusStore(path);
    await store.remember(RUN);
    const first = await store.all();
    delete first["workflow-1"];
    expect(Object.keys(await store.all())).toEqual(["workflow-1"]);
  });

  it("lands whole, so a reader never sees half a write", async () => {
    const store = new WorkflowStatusStore(path);
    await Promise.all([
      store.remember({ ...RUN, workflowId: "w-1" }),
      store.remember({ ...RUN, workflowId: "w-2" }),
      store.remember({ ...RUN, workflowId: "w-3" }),
    ]);
    const text = await readFile(path, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(Object.keys(JSON.parse(text).workflows).sort()).toEqual(["w-1", "w-2", "w-3"]);
  });
});

describe("which states count as an ending", () => {
  it("is the three that say how it turned out", () => {
    expect(isEnding("completed")).toBe(true);
    expect(isEnding("failed")).toBe(true);
    expect(isEnding("observation_lost")).toBe(true);
    expect(isEnding("detected_live")).toBe(false);
    expect(isEnding("pending_after_copy")).toBe(false);
    expect(isEnding("ambiguous_match")).toBe(false);
    expect(isEnding("idle")).toBe(false);
  });
});
