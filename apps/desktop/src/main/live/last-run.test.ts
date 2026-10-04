/**
 * A finished run, after the live store has dropped it (ANT-275).
 *
 * The launch window said "Finished" from the kept ending while the editor's
 * Live session tab said no session had ever run the workflow. These pin what
 * the tab gets back instead: the run as it was kept, or, for a record from
 * before runs were kept, one rebuilt from the journal and the binding.
 */

import { describe, expect, it } from "vitest";
import type { ObservationEvent, PendingRun } from "@anthill/live";
import type { Binding } from "@anthill/exchange-store";

import { lastRun, type LastRunSources } from "./last-run.js";
import type { WorkflowStatus } from "./workflow-status.js";

const RUN: PendingRun = {
  anthillRunId: "ANT-50ISDTEV",
  workflowId: "workflow-todo",
  promptVersion: "1",
  selectedCli: "vscode",
  createdAt: "2026-10-02T21:56:19.000Z",
  expiresAt: "2026-10-02T22:30:00.000Z",
  correlationNonce: "464lxy",
  bootstrapPromptHash: "hash",
  state: "completed",
  lastObservedAt: "2026-10-02T22:06:10.109Z",
};

const ENDING: WorkflowStatus = { state: "completed", at: "2026-10-02T22:06:10.109Z", runId: "ANT-50ISDTEV" };

function event(seq: number, extra: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    runId: "ANT-50ISDTEV",
    seq,
    at: `2026-10-02T21:56:2${seq}.000Z`,
    recordedAt: `2026-10-02T21:56:2${seq}.500Z`,
    cli: "vscode",
    source: "session",
    channel: "vscode:copilot",
    kind: "message",
    title: "Message",
    ...extra,
  };
}

const BINDING: Binding = {
  runId: "ANT-50ISDTEV",
  workflowId: "workflow-todo",
  revision: 1,
  nonce: "464lxy",
  digest: "e9209063601b3be5",
  sessionId: "vscode-chat",
  at: "2026-10-02T21:56:19.190Z",
};

function sources(events: ObservationEvent[], binding?: Binding): LastRunSources {
  return { events: async () => events, binding: async () => binding };
}

describe("the run a workflow last had", () => {
  it("is nothing for a workflow that never ran", async () => {
    expect(await lastRun("workflow-todo", undefined, sources([event(1)]))).toBeUndefined();
  });

  it("is the kept run, as it settled", async () => {
    expect(await lastRun("workflow-todo", { ...ENDING, run: RUN }, sources([]))).toBe(RUN);
  });

  it("is rebuilt from the journal and the binding for an older record", async () => {
    const run = await lastRun(
      "workflow-todo",
      ENDING,
      sources([event(1, { sessionId: "sess-a" }), event(2, { sessionId: "sess-b" })], BINDING),
    );
    expect(run).toMatchObject({
      anthillRunId: "ANT-50ISDTEV",
      workflowId: "workflow-todo",
      selectedCli: "vscode",
      state: "completed",
      createdAt: BINDING.at,
      lastObservedAt: ENDING.at,
      closedAt: ENDING.at,
      detectedSessionId: "sess-b",
      correlationNonce: "464lxy",
      // The revision that ran, so the page draws it and not the edited canvas.
      exchange: { revision: 1, digest: "e9209063601b3be5", sessionId: "vscode-chat" },
    });
  });

  it("is rebuilt without a binding for a run that was not a handover", async () => {
    const run = await lastRun("workflow-todo", ENDING, sources([event(1)]));
    expect(run?.exchange).toBeUndefined();
    expect(run?.createdAt).toBe(event(1).at);
  });

  it("says the author stopped observing it when they did", async () => {
    const run = await lastRun(
      "workflow-todo",
      { ...ENDING, state: "observation_lost", stopped: true },
      sources([event(1)]),
    );
    expect(run?.observationStoppedAt).toBe(ENDING.at);
  });

  it("is nothing when the journal is empty or cannot be read", async () => {
    expect(await lastRun("workflow-todo", ENDING, sources([], BINDING))).toBeUndefined();
    const broken: LastRunSources = {
      events: async () => {
        throw new Error("EACCES");
      },
      binding: async () => BINDING,
    };
    expect(await lastRun("workflow-todo", ENDING, broken)).toBeUndefined();
  });
});
