/**
 * Workflow mode: design a workflow as a diagram, get a prompt out.
 *
 * Nothing here executes anything — the output is text plus files the author
 * drops into their own repository.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NO_SELECTION,
  WorkflowCanvas,
  addNode,
  createNode,
  dropPosition,
  type LinkingState,
  type WorkflowSelection,
} from "@anthill/builder";
import {
  HARNESS_PROFILES,
  addAgentProfile,
  addOutput,
  agentProfiles,
  allIssues,
  assignAgent,
  findCycles,
  issuesForNode,
  nodesOnCycles,
  stepsUsingAgent,
  stampWorkflowFormat,
  validateWorkflow,
  openSpot,
  withRunRoot,
  type WorkflowTemplate,
} from "@anthill/workflow";
import { type Workflow } from "@anthill/workflow-schema";
import type { PendingRun } from "@anthill/live";
import { handoverOpens, revisionDigest } from "@anthill/workflow-exchange";

import { SAVED_LINGER_MS, type SaveStatus } from "./save-status.js";
import { AgentEditor } from "./AgentLibrary.js";
import { type CustomBlock, type LibraryBlock } from "./BlockLibrary.js";
import { BlockInspector } from "./BlockInspector.js";
import { WorkflowLibraries, type LibraryTab } from "./WorkflowLibraries.js";
import { ProblemsPopover, type ProblemTarget } from "./ProblemsPopover.js";
import { OutputInspector } from "./OutputInspector.js";
import { PromptToWorkflowSheet } from "./PromptToWorkflowSheet.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { blankWorkflow, UNTITLED_WORKFLOW } from "./sample-workflow.js";
import { PromptModal } from "./PromptModal.js";
import { ExportModal } from "./ExportModal.js";
import { fileName, RevealPath } from "./RevealPath.js";
import { DescribeChangeAssistant } from "./DescribeChangeAssistant.js";
import {
  canStepBack,
  canStepForward,
  emptyHistory,
  recordEdit,
  stepBack,
  stepForward,
  type History,
} from "./workflow-history.js";
import { LiveIndicator } from "../live/LiveIndicator.js";
import { PresencePlaque } from "../live/PresenceChip.js";
import { hasSessionPage, mostRelevant, presenceKey, runsFor } from "../live/presence.js";
import {
  markAnnounced,
  SessionStartedDialog,
  shouldAnnounce,
} from "../live/SessionStartedDialog.js";
import { LiveSessionPage } from "../live/LiveSessionPage.js";
import { WorkflowToolbar, type ToolbarHandover } from "./WorkflowToolbar.js";
import { HandoverNotice } from "./HandoverNotice.js";
import { WorkspaceTabs, type WorkspaceTab } from "./WorkspaceTabs.js";
import { handoverModel } from "./handover.js";
import { useExchange } from "./use-exchange.js";
import { CanvasTour } from "../tour/CanvasTour.js";
import { CANVAS_TOUR, markTourSeen, tourDue } from "../tour/tour-steps.js";

export type WorkflowScreenProps = {
  onExit: () => void;
  /** The rail's door to Settings. App-level, so the screen only forwards it. */
  onSettings: () => void;
  /**
   * What the launch window sent the author here to do. Without it the workflow
   * would show its own start screen on top of the one they just used.
   */
  start?:
    | { kind: "templates" }
    | { kind: "prompt" }
    | { kind: "open"; path?: string; live?: PendingRun; deliveryId?: number };
};

/** Whether a text field has focus, where ⌘Z belongs to the text. */
function typingInAField(): boolean {
  const active = document.activeElement;
  const tag = active?.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    Boolean((active as HTMLElement | null)?.isContentEditable)
  );
}

/** Long enough to read a sentence; it is about one click, so it does not stay. */
const REVEAL_ERROR_MS = 4000;

export function WorkflowScreen({ onExit, onSettings, start }: WorkflowScreenProps) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  /**
   * Where the workflow has been, and where it was stepped back from.
   *
   * Every change goes through `editWorkflow`, so keeping history around that
   * one funnel covers the canvas, the inspector, the agent library and the
   * assistant at once — there is no per-surface undo to keep in step, because
   * there is only one place a change can happen.
   */
  const [history, setHistory] = useState<History<Workflow>>(() => emptyHistory<Workflow>());
  const [selection, setSelection] = useState<WorkflowSelection>(NO_SELECTION);
  const [linking, setLinking] = useState<LinkingState>(null);
  const [path, setPath] = useState<string | undefined>();
  const [exchangePath, setExchangePath] = useState<string | undefined>();
  /** What went wrong with the last Reveal, said briefly above the status bar. */
  const [revealError, setRevealError] = useState<string | null>(null);
  /** The shell's system and home: the reveal's wording, and `~` in the path. */
  const [host, setHost] = useState<{ platform?: string; home?: string }>({});
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => window.anthill.capabilities())
      .then(({ platform, home }) => {
        if (live) setHost({ platform, home });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [dirty, setDirty] = useState(false);
  const currentWorkflow = useRef(workflow);
  currentWorkflow.current = workflow;
  /**
   * The workflow as it stands in its file: as opened, or as last saved. None
   * for a draft that was never saved. Stepping the history back to it is
   * being back to the file, and nothing is unsaved (ANT-207).
   */
  const savedAs = useRef<Workflow | null>(null);
  const matchesSaved = (candidate: Workflow): boolean =>
    savedAs.current !== null &&
    (candidate === savedAs.current || JSON.stringify(candidate) === JSON.stringify(savedAs.current));
  const delivered = useRef(start?.kind === "open" ? start : undefined);
  useEffect(() => {
    if (!workflow) return;
    const openedPath = exchangePath ?? path;
    const deliveryId = delivered.current?.path === openedPath ? delivered.current?.deliveryId : undefined;
    delivered.current = undefined;
    void window.anthill.workflowOpened(openedPath ?? "", deliveryId);
  }, [path, exchangePath, workflow?.id]);
  useEffect(() => () => { void window.anthill.workflowOpened(""); }, []);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  /** Held in a ref, not state: it gates the next call, it does not draw. */
  const saving = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryTab>("blocks");
  const [showProblems, setShowProblems] = useState(false);
  /** The pill the Problems index hangs from, measured rather than guessed. */
  const problemsPill = useRef<HTMLButtonElement>(null);
  /**
   * Where the inspector came from when an agent was opened from a step.
   *
   * Opening an agent from a block replaces what the inspector is showing, so it
   * owes the reader a way back to the step they were reading. Cleared by any
   * other selection, because a trail back to somewhere nobody was is noise.
   */
  const [agentReturn, setAgentReturn] = useState<string | undefined>();
  const [fromPrompt, setFromPrompt] = useState(start?.kind === "prompt");
  /**
   * True from the moment a drafted workflow lands until its assembly reveal
   * has run once. Only a draft assembles — an opened file or an edit draws at
   * once — and the flag drops on the first edit so the animation can never
   * replay over the author's own change.
   */
  const [assembling, setAssembling] = useState(false);
  const [custom, setCustom] = useState<CustomBlock[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>();
  const [firstMeaningfulEdit, setFirstMeaningfulEdit] = useState(false);

  /**
   * Whether the Prompt modal is open.
   *
   * The prompt has one home now. It used to be a sidebar tab as well, which
   * made the thing the user actually leaves with feel like an inspector panel;
   * the sidebar is for editing the workflow, and this is the handover.
   */
  const [showPrompt, setShowPrompt] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [describing, setDescribing] = useState(false);
  /** Blocks the author pointed at for the assistant, as ids. */
  const [mentions, setMentions] = useState<string[]>([]);
  /**
   * The one way in and out of the assistant.
   *
   * The canvas pill and the sidebar's ✕ both call this, so they cannot
   * disagree — an earlier pass had the ✕ clearing the references and the pill
   * not, which left a reopened assistant pointing at blocks from a request
   * that was abandoned.
   */
  const toggleAssistant = useCallback(() => {
    setDescribing((on) => {
      if (on) setMentions([]);
      return !on;
    });
  }, []);
  /**
   * Whether the canvas tour is showing. Read once per screen: it is due after
   * onboarding or a Show tips, and the canvas it points at only exists once a
   * workflow is open — which is when this component renders the canvas.
   */
  const [touring, setTouring] = useState(() => tourDue());
  /**
   * The observed session open in this window's Live session tab, if any.
   *
   * Set when the reader opens one — from the live chip, the announcement, the
   * tab itself, or a `watch` handover going there by itself — and cleared only
   * by Stop observing. Switching to the Workflow tab keeps it, and keeps its
   * page mounted, so the feed goes on arriving and the page is as it was left
   * when they come back (ANT-267).
   */
  const [liveRun, setLiveRun] = useState<PendingRun | null>(
    start?.kind === "open" && start.live ? start.live : null,
  );
  const [tab, setTab] = useState<WorkspaceTab>(
    start?.kind === "open" && start.live ? "live" : "workflow",
  );
  /** Without a session open there is only the workflow to show. */
  const showing: WorkspaceTab = liveRun ? tab : "workflow";
  const openLive = useCallback((run: PendingRun) => {
    setLiveRun(run);
    setTab("live");
  }, []);
  /** What the CLI behind the open live run can expose, as main reported it. */
  const [liveObservation, setLiveObservation] = useState<
    { available: boolean; note: string } | undefined
  >();

  /**
   * Keep the open live page's run in step with what main knows.
   *
   * The page was given a copy of the run when it opened and never a newer one,
   * so everything the page says *about the run* — the status chip, the
   * evidence, the last-seen time, and the final step, which only settles once
   * the run itself has — stayed frozen at the moment it was opened. A session
   * that finished went on being drawn as live indefinitely.
   *
   * A run that is no longer in the snapshot was cancelled or dismissed
   * elsewhere; the last thing known about it is kept rather than blanked, so
   * the page never loses what it was showing.
   */
  const [liveRuns, setLiveRuns] = useState<PendingRun[]>([]);
  const [liveStorageError, setLiveStorageError] = useState<string>();

  useEffect(() => {
    let live = true;
    // Any push is newer than the answer to the first ask, which may still be
    // in flight; letting that answer land afterwards would put a finished run
    // back to Live (ANT-157).
    let pushed = false;
    // Ask once as well as subscribing. A push only arrives when something
    // changes, so without this the canvas knows nothing about a session that
    // was already being observed when this screen opened — and the
    // announcement for it would never fire either.
    void window.anthill
      .liveSnapshot()
      .then((snapshot) => {
        if (live && !pushed) {
          setLiveRuns(snapshot.runs);
          setLiveStorageError(snapshot.storageError);
        }
      })
      .catch(() => {
        // An older main process does not serve this channel. The indicator
        // reports that itself; the canvas simply stays quiet.
      });

    let off: (() => void) | undefined;
    try {
      off = window.anthill.onLiveSnapshot((snapshot) => {
        pushed = true;
        setLiveRuns(snapshot.runs);
        setLiveStorageError(snapshot.storageError);
        setLiveRun((current) => {
          if (!current) return current;
          const next = snapshot.runs.find(
            (candidate) => candidate.anthillRunId === current.anthillRunId,
          );
          return next ?? current;
        });
      });
    } catch {
      // An older main process does not serve this channel. The page still
      // works from the event feed; it just cannot refresh the run's own state,
      // and the health check on the page is what says so.
    }
    return () => {
      live = false;
      off?.();
    };
  }, []);

  /**
   * The run the canvas speaks for — the same one the chip features, and only
   * ever one started from the workflow that is open.
   */
  const watched = mostRelevant(runsFor(liveRuns, workflow?.id));

  /**
   * The run this workflow last had, once the live store has let it go
   * (ANT-275).
   *
   * The store drops a settled run a day after it ends, and the tab then said
   * no session had ever run a workflow the launch window called Finished. Main
   * keeps how each workflow's last run ended, and hands that run back here so
   * the finished session can still be opened. Asked only while the snapshot
   * has nothing for the workflow: anything it does have is the answer.
   */
  const workflowId = workflow?.id;
  const [ended, setEnded] = useState<{ workflowId: string; run: PendingRun }>();
  const snapshotHasRun = watched !== undefined;
  useEffect(() => {
    if (!workflowId || snapshotHasRun) return;
    let live = true;
    Promise.resolve()
      .then(() => window.anthill.liveLastRun(workflowId))
      .then((run) => {
        if (live && run?.workflowId === workflowId) setEnded({ workflowId, run });
      })
      .catch(() => {
        // An older main process does not serve this channel. The tab stays
        // as it was: open while the live store has the run, and not after.
      });
    return () => {
      live = false;
    };
  }, [workflowId, snapshotHasRun]);
  const endedRun = ended?.workflowId === workflowId ? ended?.run : undefined;

  /** Open one agent in the inspector, remembering the step it came from. */
  const editAgent = useCallback(
    (agentId: string, from?: string) => {
      setSelectedAgent(agentId);
      setLibrary("agents");
      setAgentReturn(from);
    },
    [],
  );

  const selectStep = useCallback((nodeId: string) => {
    setSelection({ kind: "block", nodeId });
    setSelectedAgent(undefined);
    setAgentReturn(undefined);
  }, []);

  const validation = useMemo(
    () => (workflow ? validateWorkflow(workflow) : { valid: true, errors: [] }),
    [workflow],
  );
  const loops = useMemo(
    () => (workflow ? nodesOnCycles(workflow).size > 0 : false),
    [workflow],
  );

  /**
   * Record the dirty state where the main process can read it at close time.
   * Set synchronously: IPC is asynchronous, so an edit followed immediately by
   * a window close could otherwise be decided on a stale value.
   */
  const markDirty = useCallback((value: boolean) => {
    setDirty(value);
    (window as unknown as Record<string, unknown>).__anthillWorkflowDirty = value;
    void window.anthill.setWorkflowDirty(value);
  }, []);

  const editWorkflow = useCallback(
    (next: Workflow | ((current: Workflow) => Workflow)) => {
      setWorkflow((current) => {
        if (!current) return current;
        const after = typeof next === "function" ? next(current) : next;
        // Recorded here rather than by the caller: this is the one place that
        // knows both what is being left and what is arriving, and a caller
        // that forgot would leave a gap in the history nobody would notice.
        if (after !== current) setHistory((past) => recordEdit(past, current));
        return after;
      });
      setFirstMeaningfulEdit(true);
      // An edit mid-reveal ends the reveal: replaying an entrance over the
      // author's own change would animate something that is not new.
      setAssembling(false);
      markDirty(true);
    },
    [markDirty],
  );

  /**
   * Step the workflow back, or forward again.
   *
   * A step is not an edit: it does not push onto the history it is walking,
   * and it does not restart the assembly reveal. It marks the file dirty
   * when the workflow on screen now differs from the one on disk, whichever
   * direction it was reached from — and clean when it is back to it.
   */
  const step = useCallback(
    (direction: "back" | "forward") => {
      if (!workflow) return;
      const walk = direction === "back" ? stepBack : stepForward;
      const taken = walk(history, workflow);
      if (!taken) return;
      // Everything here is a plain event handler, deliberately. An earlier
      // pass did this work inside a `setWorkflow` updater, which meant setting
      // other state during React's render phase: under StrictMode the updater
      // ran twice, the history advanced, and the workflow it was supposed to
      // restore never arrived — Step back moved the buttons and left the
      // canvas exactly as it was.
      setHistory(taken.history);
      setWorkflow(taken.state);
      markDirty(!matchesSaved(taken.state));
      // What was selected may not exist in the state being restored, and an
      // inspector pointing at a block that is gone is worse than none.
      setSelection(NO_SELECTION);
      setSelectedAgent(undefined);
      setAgentReturn(undefined);
    },
    [workflow, history, markDirty],
  );

  /**
   * ⌘Z and ⇧⌘Z, the two shortcuts every editor has.
   *
   * Ignored while a text field has focus: there ⌘Z is the browser's own undo
   * of what was typed, and stealing it would make correcting a typo throw away
   * the whole edit instead.
   */
  /** When the keys last stepped the history, so the menu's echo of them is not a second step. */
  const keyStepAt = useRef(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      // The canvas is behind the Live session tab: an undo there would change
      // a workflow nobody is looking at.
      if (showing !== "workflow" || typingInAField()) return;
      event.preventDefault();
      keyStepAt.current = Date.now();
      step(event.shiftKey ? "forward" : "back");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, showing]);

  /*
    The same two, from the app's Edit menu. In the app the menu takes ⌘Z and
    ⇧⌘Z before this page sees them, so the handler above never ran there and
    the canvas could only be stepped from its buttons (ANT-192). The menu undoes
    typing in a field itself; here, outside one, the workflow steps.
  */
  useEffect(
    () =>
      window.anthill.onEditHistory?.((action) => {
        if (showing !== "workflow" || typingInAField()) return;
        if (Date.now() - keyStepAt.current < 400) return;
        step(action === "redo" ? "forward" : "back");
      }),
    [step, showing],
  );

  const replaceWorkflow = useCallback(
    (next: Workflow, nextPath?: string, nextExchangePath?: string) => {
      setWorkflow(next);
      // A different workflow is a different history. Stepping back into the
      // one before it was opened would restore a file the author has left.
      setHistory(emptyHistory<Workflow>());
      setPath(nextPath);
      setExchangePath(nextExchangePath);
      setRevealError(null);
      setSelection(NO_SELECTION);
      setLinking(null);
      setSelectedAgent(undefined);
      setAgentReturn(undefined);
      // Opening a file or a template draws at once. Only the accept handler
      // re-raises this, for the one workflow that is new to its reader.
      setAssembling(false);
      savedAs.current = next;
      markDirty(false);
    },
    [markDirty],
  );

  useEffect(() => {
    markDirty(false);
    return () => markDirty(false);
  }, [markDirty]);


  const confirmDiscard = useCallback(
    (action: string) =>
      !dirty ||
      window.confirm(
        `This workflow has unsaved changes.\n\n${action} discards everything since the last save.`,
      ),
    [dirty],
  );

  const open = useCallback(async (path?: string) => {
    if (!confirmDiscard("Opening another workflow")) return;
    const result = await window.anthill.openWorkflow(path);
    if (!result.ok) {
      if ("cancelled" in result) return;
      setNotice(result.error);
      return;
    }
    const { exchangePath: handedOver, path: opened } = result.opened;
    // A handover whose JSON could not be exported has no file of its own yet:
    // the exchange working copy is not one to reveal.
    replaceWorkflow(result.opened.workflow, opened === handedOver ? undefined : opened, handedOver);
    setNotice(result.opened.notice ?? null);
  }, [confirmDiscard, replaceWorkflow]);

  // Opening a workflow the launch window already chose: done once, on arrival.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || start?.kind !== "open") return;
    opened.current = true;
    void open(start.path);
  }, [start, open]);

  const save = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!workflow) return;
    // One press, one write. A second click while the first is in flight would
    // race it to the same file and could report the older answer last, so it
    // is dropped rather than queued — the save already running is the one the
    // author asked for (ANT-58).
    if (saving.current) return;
    saving.current = true;
    setSaveStatus({ kind: "saving" });
    try {
      const result = await window.anthill.saveWorkflow({
        workflow: stampWorkflowFormat(workflow),
        path,
        ...(exchangePath ? { exchangePath } : {}),
        ...(options.quiet ? { quiet: true } : {}),
      });
      if (result.kind === "saved") {
        setPath(result.path);
        setExchangePath(result.exchangePath);
        setRevealError(null);
        // Edits made while the save was awaiting IPC are still unsaved.
        savedAs.current = workflow;
        if (currentWorkflow.current === workflow) markDirty(false);
        setNotice(null);
        setSaveStatus({ kind: "saved" });
        return;
      }
      // Cancelling is a decision, not a fault: nothing was written and nothing
      // is claimed. The dirty pill goes on saying what is true.
      setSaveStatus(result.kind === "failed" ? { kind: "failed", error: result.error } : { kind: "idle" });
    } catch (error) {
      setSaveStatus({
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving.current = false;
    }
  }, [workflow, path, exchangePath, markDirty]);

  const reveal = useCallback(async () => {
    if (!path) return;
    setRevealError(null);
    try {
      if (!await window.anthill.revealPath(path)) {
        // Moved or deleted since it was written. The path stays on show,
        // because it is where the file was; the file manager is not opened on
        // a folder that no longer holds it.
        setRevealError(`${fileName(path)} is no longer at this path`);
      }
    } catch (error) {
      setRevealError(`Could not show ${fileName(path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [path]);

  // Said once, briefly: it is about the click, not the workflow.
  useEffect(() => {
    if (!revealError) return;
    const timer = setTimeout(() => setRevealError(null), REVEAL_ERROR_MS);
    return () => clearTimeout(timer);
  }, [revealError]);

  const revealNow = useRef(reveal);
  revealNow.current = reveal;
  useEffect(() => window.anthill.onRevealWorkflow?.(() => void revealNow.current()), []);
  useEffect(() => { void window.anthill.setWorkflowRevealable?.(Boolean(path)); }, [path]);
  useEffect(() => () => { void window.anthill.setWorkflowRevealable?.(false); }, []);

  /**
   * File ▸ Save and ⌘S, which are the same one thing.
   *
   * The key is bound in the application menu, not here: an accelerator is
   * consumed before the page sees it, so one press cannot become two saves and
   * ⌘S can never fall through to the browser's own Save Page (ANT-59). It also
   * works with a text field focused, which a page-level key handler would have
   * had to make an exception for.
   *
   * Nothing is flushed before saving because nothing is held back — every
   * field in this editor commits as it is typed, so the workflow in hand is
   * already what is on screen. Blurring "just in case" would take the caret
   * away from the author and buy nothing.
   *
   * The latest `save` is reached through a ref so this subscribes once. Read
   * directly it would close over the first one and go on saving the workflow
   * as it stood when the screen opened.
   */
  const saveNow = useRef(save);
  saveNow.current = save;
  useEffect(() => window.anthill.onSaveWorkflow(() => void saveNow.current()), []);

  /**
   * A save the run folder asked for, made once the edit is in the workflow
   * (ANT-180): `save` reads the workflow it closes over, so it has to wait
   * for the render that carries the change.
   */
  const quietSave = useRef(false);
  useEffect(() => {
    if (!quietSave.current) return;
    quietSave.current = false;
    void save();
  }, [workflow, save]);

  /**
   * A new workflow's JSON is in the workflow folder as soon as it has a title
   * (ANT-206): a draft or a template at once, a blank one when the author has
   * named it. The file keeps the name it was made with, so a blank workflow
   * is not filed under its placeholder while the author is still typing.
   */
  const createFileIfTitled = useCallback(() => {
    const name = workflow?.name.trim();
    if (path || exchangePath || !name || name === UNTITLED_WORKFLOW) return;
    void save({ quiet: true });
  }, [workflow, path, exchangePath, save]);
  /** Set by a new draft or template; `save` reads the workflow it closes over, so this waits for its render. */
  const createFile = useRef(false);
  useEffect(() => {
    if (!createFile.current || !workflow) return;
    createFile.current = false;
    createFileIfTitled();
  }, [workflow, createFileIfTitled]);

  // "Saved" is about the click, so it goes when the click stops being recent.
  // A failure stays until something else happens: it is the author's to read.
  useEffect(() => {
    if (saveStatus.kind !== "saved") return;
    const timer = window.setTimeout(() => setSaveStatus({ kind: "idle" }), SAVED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  const exit = useCallback(() => {
    if (!confirmDiscard("Leaving the workflow screen")) return;
    onExit();
  }, [confirmDiscard, onExit]);

  const startLinking = useCallback((nodeId: string, outputId: string) => {
    setLinking({ nodeId, outputId });
    setSelection({ kind: "output", nodeId, outputId });
    setSelectedAgent(undefined);
  }, []);

  /** Add a block from the library, at a given canvas point or a default spot. */
  const addFromLibrary = useCallback(
    (block: LibraryBlock, at?: { x: number; y: number }, canvasSize?: { width: number; height: number }) => {
      editWorkflow((current) => {
        const position =
          at && canvasSize
            ? dropPosition(at, canvasSize)
            : // A free spot, never on top of a block or across the top row's
              // connections (ANT-183), nor on anyone's unconnected outputs
              // (ANT-205). Every block but End starts with one of its own.
              openSpot(current.nodes, { unconnectedOutputs: block.nodeType !== "end" });

        const node = createNode(current, block.nodeType ?? "agent", {
          name: block.label,
          position,
          config: block.nodeType
            ? block.nodeType === "approval"
              ? { prompt: "" }
              : {}
            : { actionKind: block.actionKind, purpose: block.summary, task: "" },
        });

        let next = addNode(current, node);

        // A new step gets an agent of its own, so it is assignable straight
        // away. Pointing it at an existing agent is one choice in its
        // inspector; the alternative — leaving it unassigned — starts every
        // new step with a validation error.
        if (!block.nodeType) {
          const created = addAgentProfile(next, { name: "" });
          next = assignAgent(created.workflow, node.id, created.agentId);
        }

        if (block.nodeType === "end") return next;

        // Every new block starts with a way out, so the workflow can be continued
        // without first working out how to add an output. The Condition
        // control seeds two — a block with only one output has nothing to
        // route between.
        const outputCount = block.seedOutputs ?? 1;
        for (let i = 0; i < outputCount; i += 1) {
          next = addOutput(next, node.id).workflow;
        }
        return next;
      });
    },
    [editWorkflow],
  );

  /*
   * The handover, read once for the whole screen.
   *
   * Called here rather than where it is used because a hook cannot sit behind
   * the early returns below, and read at all because the state changes outside
   * this app: another session binds a revision and nothing tells us.
   */
  const exchange = useExchange(workflow?.id ?? "", exchangePath ?? path, dirty);

  /**
   * Whether this handover was made to be watched rather than edited (ANT-118).
   *
   * `watch` is what the user asked the harness for when they wanted to see the
   * work happen: the harness wrote the graph itself and is already doing the
   * job, so there is no version of it for them to settle and no reason to open
   * a canvas they were not invited to change. Read through `handoverOpens`,
   * never compared to a literal, so the two retired mode names fold into
   * `design` in one place.
   */
  const opensLive = exchange.view !== undefined && handoverOpens(exchange.view.mode) === "live";

  /**
   * The one run still owed an announcement.
   *
   * Gated on a confirmed match and nothing weaker: a modal takes the author
   * off what they were doing, and "a session here might be yours" is not worth
   * that. Everything less certain stays in the chip, where a reader goes
   * looking rather than being pulled.
   *
   * A `watch` handover is never announced, because the next effect is already
   * taking the reader there. Asking "open the session?" of somebody who asked
   * for nothing else is a dialog with one answer. Nor is a run already open in
   * the Live session tab: the dialog would be waiting on the canvas, offering
   * the session they just came from.
   */
  const [announcing, setAnnouncing] = useState<PendingRun | null>(null);
  const openRunId = liveRun?.anthillRunId;
  useEffect(() => {
    if (!watched || opensLive || !shouldAnnounce(watched)) return;
    markAnnounced(watched.anthillRunId);
    if (watched.anthillRunId === openRunId) return;
    setAnnouncing(watched);
  }, [watched, opensLive, openRunId]);

  /**
   * A `watch` handover goes to its session by itself.
   *
   * It cannot happen at the handover: a workflow arrives before anything has
   * bound it, and a Live Session page with no run would be a page about
   * nothing. So the canvas holds the graph for the second or two the harness
   * takes to bind, and the moment a run for this workflow appears the page
   * changes underneath it. That is the whole of "no editing step" — the user
   * never has to find the indicator and click it.
   *
   * Once per run, and remembered: `Stop observing` and the Workflow tab both
   * put the reader on the canvas deliberately, and an effect that sent them
   * straight back would make the tab and the button unusable.
   */
  const sentToLive = useRef<string | null>(null);
  const workflowShown = useRef(false);
  useEffect(() => {
    if (!opensLive || !watched || sentToLive.current === watched.anthillRunId) return;
    sentToLive.current = watched.anthillRunId;
    markAnnounced(watched.anthillRunId);
    openLive(watched);
  }, [opensLive, watched, openLive]);

  if (!workflow) {
    if (fromPrompt) {
      return (
        <PromptToWorkflowSheet
          onCancel={() => setFromPrompt(false)}
          onAccept={(drafted) => {
            setFromPrompt(false);
            createFile.current = true;
            replaceWorkflow(drafted);
            // The accepted draft assembles on the canvas — the one time the
            // graph builds rather than appears, because this is the one time
            // the graph is new to the person looking at it.
            setAssembling(true);
            // A drafted workflow has never been saved, and closing without saving
            // it would lose it — so it starts dirty rather than pretending to
            // match a file on disk.
            savedAs.current = null;
            markDirty(true);
          }}
        />
      );
    }
    return (
      <TemplatePicker
        onPick={(template: WorkflowTemplate) => {
          createFile.current = true;
          replaceWorkflow(template.build());
        }}
        onBlank={() => replaceWorkflow(blankWorkflow())}
        onOpen={() => void open()}
        onFromPrompt={() => setFromPrompt(true)}
        onCancel={onExit}
      />
    );
  }

  const selectedNode =
    selection.kind === "block"
      ? workflow.nodes.find((node) => node.id === selection.nodeId)
      : selection.kind === "output"
        ? workflow.nodes.find((node) => node.id === selection.nodeId)
        : undefined;

  const agents = agentProfiles(workflow);
  const issues = allIssues(validation);
  const cycles = findCycles(workflow);
  const outputCount = workflow.edges.length;

  /** Follow a problem to the thing it is about. */
  /**
   * Take the author to a problem — in whichever mode they are in.
   *
   * The assistant replaces the inspector rather than sitting beside it, so
   * while it is open a selection has nowhere to be shown. This set the
   * selection anyway and the click did nothing at all: the popover closed and
   * the author was left where they started (ANT-114).
   *
   * So it speaks the mode's own verb. With the assistant open a canvas click
   * *mentions* a block rather than selecting one, and this now does the same:
   * the block joins the mentions, so whatever the author types next is already
   * about it. Which is also how they hand the problem to the assistant.
   */
  const goToProblem = (target: ProblemTarget) => {
    if (describing) {
      setMentions((current) =>
        current.includes(target.nodeId) ? current : [...current, target.nodeId],
      );
      return;
    }
    setSelectedAgent(undefined);
    setAgentReturn(undefined);
    if (target.kind === "block") setSelection({ kind: "block", nodeId: target.nodeId });
    else setSelection({ kind: "output", nodeId: target.nodeId, outputId: target.edgeId });
  };

  /*
   * What the toolbar's pill, its primary slot and the floating notice all say.
   *
   * Worked out in one place from one problem count: the pill, the canvas chips
   * and the inspector each derived their own once, and they contradicted each
   * other on screen at the same moment.
   */
  const handover: ToolbarHandover | undefined = exchange.view
    ? {
        model: handoverModel({
          view: exchange.view,
          problemCount: validation.errors.length,
          // A save that did not land is the one thing about a handover the
          // exchange cannot tell us: it only ever sees writes that arrived.
          ...(saveStatus.kind === "failed" ? { saveError: saveStatus.error } : {}),
          runs: liveRuns,
        }),
        source: exchange.view.source,
      }
    : undefined;

  const selectedAgentProfile = agents.find((profile) => profile.id === selectedAgent);
  const returnStep = agentReturn
    ? workflow.nodes.find((node) => node.id === agentReturn)
    : undefined;

  const selectedIssues = selectedNode ? issuesForNode(validation, selectedNode.id) : [];

  /** What the one inspector is showing, and what its header says about it. */
  const inspecting: { title: string; count?: string } = selectedAgentProfile
    ? {
        title: "Agent profile",
        count: `${stepsUsingAgent(workflow, selectedAgentProfile.id).length} steps`,
      }
    : selection.kind === "output"
      ? { title: "Selected connection" }
      : selectedNode
        ? {
            title: "Selected block",
            ...(selectedIssues.length > 0 ? { count: `${selectedIssues.length} to fix` } : {}),
          }
        : { title: "Inspector" };

  /*
   * The run as the store has it now, not as it was when something pointed at
   * it. The dialog and the chip hand over the copy they were shown, and the
   * snapshot subscription only replaces `liveRun` when a *new* snapshot
   * arrives — a session that had already finished sends none, so the page kept
   * a `detected_live` copy for good and said Live over a finished run
   * (ANT-157). Looking the run up by id on every render cannot go stale.
   */
  const current = (run: PendingRun): PendingRun =>
    liveRuns.find((candidate) => candidate.anthillRunId === run.anthillRunId) ?? run;

  /*
   * What the Live session tab would show: the run open in it, or else the one
   * the chip would open — a session confirmed live, or one that finished.
   * Anything less certain leaves the tab disabled — the chip is where a maybe
   * is explained. With no run in the snapshot at all, the finished session the
   * workflow last had, kept after the store dropped it (ANT-275).
   */
  const liveTarget = liveRun
    ? current(liveRun)
    : watched
      ? hasSessionPage(watched)
        ? watched
        : undefined
      : endedRun && hasSessionPage(endedRun)
        ? endedRun
        : undefined;
  const tabs = (
    <WorkspaceTabs
      active={showing}
      liveEnabled={liveTarget !== undefined}
      liveNow={liveTarget?.state === "detected_live"}
      onSelect={(next) => {
        if (next === "workflow") setTab("workflow");
        else if (liveRun) setTab("live");
        else if (liveTarget) {
          markAnnounced(liveTarget.anthillRunId);
          setAnnouncing(null);
          openLive(liveTarget);
        }
      }}
    />
  );

  /*
   * The canvas is built the first time its tab is shown, and kept from then
   * on. A window opened straight onto a session would otherwise lay out and
   * frame a canvas measured at nothing, and show it unframed later.
   */
  if (showing === "workflow") workflowShown.current = true;

  const workflowPage = (
    <div className="app" hidden={showing !== "workflow"}>
      {announcing && workflow ? (
        <SessionStartedDialog
          run={current(announcing)}
          workflowName={workflow.name}
          onOpenSession={() => {
            openLive(current(announcing));
            setAnnouncing(null);
          }}
          onDismiss={() => setAnnouncing(null)}
        />
      ) : null}

      {showPrompt ? (
        <PromptModal
          workflow={workflow}
          validation={validation}
          onRunRoot={(root) => {
            // Where the agent files go is not an edit the author made. A
            // workflow that was saved and unchanged stays saved: the folder is
            // written into its file on the spot, rather than leaving it
            // "Unsaved" and every run ending on a discard-changes dialog
            // (ANT-180).
            if (!dirty && path) quietSave.current = true;
            editWorkflow((current) => withRunRoot(current, root));
          }}
          onObserving={() => {
            // A run from a workflow that was never saved had nowhere to be
            // found once the editor closed: no file, so no row on the launch
            // window (ANT-177). The workflow is saved into the workflow folder
            // as the prompt leaves, so the run it starts can be reached again.
            if (!path) void save({ quiet: true });
          }}
          onClose={() => setShowPrompt(false)}
        />
      ) : null}

      {showExport ? <ExportModal workflow={workflow} onClose={() => setShowExport(false)} /> : null}

      <WorkflowToolbar
        workflow={workflow}
        onExit={exit}
        onRename={(name) => editWorkflow((current) => ({ ...current, name }))}
        onRenameDone={createFileIfTitled}
        onTarget={(target) => editWorkflow((current) => ({ ...current, target }))}
        dirty={dirty}
        saveStatus={saveStatus}
        problemCount={validation.errors.length}
        showProblems={showProblems}
        onToggleProblems={() => setShowProblems((current) => !current)}
        problemsPill={problemsPill}
        canStepBack={canStepBack(history)}
        canStepForward={canStepForward(history)}
        onStep={step}
        onSave={() => void save()}
        onPrompt={() => setShowPrompt(true)}
        onExport={() => setShowExport(true)}
        {...(handover ? { handover } : {})}
        tabs={tabs}
      />

      {showProblems ? (
        <ProblemsPopover
          workflow={workflow}
          issues={issues}
          onClose={() => setShowProblems(false)}
          onGo={goToProblem}
          anchor={problemsPill}
        />
      ) : null}

      {notice ? (
        <div className="banner">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      ) : null}

      <div className="body">
        <WorkflowLibraries
          onSettings={onSettings}
          workflow={workflow}
          onChange={editWorkflow}
          tab={library}
          onTabChange={setLibrary}
          custom={custom}
          onAddCustom={(block) => setCustom((current) => [...current, block])}
          onAddBlock={(block) => addFromLibrary(block)}
          {...(selectedAgent ? { selectedAgentId: selectedAgent } : {})}
          onSelectAgent={(agentId) => {
            setSelectedAgent(agentId);
            setAgentReturn(undefined);
            if (agentId) setSelection(NO_SELECTION);
          }}
        />

        <div
          className="canvas-area"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const raw = event.dataTransfer.getData("application/anthill-block");
            if (!raw) return;
            const box = event.currentTarget.getBoundingClientRect();
            addFromLibrary(
              JSON.parse(raw) as LibraryBlock,
              { x: event.clientX - box.left, y: event.clientY - box.top },
              { width: box.width, height: box.height },
            );
          }}
        >
          <WorkflowCanvas
            workflow={workflow}
            onChange={editWorkflow}
            validation={validation}
            selection={selection}
            onSelectionChange={(next) => {
              setSelection(next);
              // Any canvas selection replaces what the inspector shows, so an
              // agent left open there stops being what is selected.
              setSelectedAgent(undefined);
              setAgentReturn(undefined);
            }}
            {...(describing
              ? {
                  onBlockPick: (nodeId: string) =>
                    setMentions((current) =>
                      current.includes(nodeId)
                        ? current.filter((id) => id !== nodeId)
                        : [...current, nodeId],
                    ),
                }
              : {})}
            linking={linking}
            onLinkingChange={setLinking}
            assembling={assembling}
          />

          {/* Anchored to the canvas, not the topbar: this edits the diagram,
              so it belongs to the diagram's own chrome rather than beside
              New/Open/Save/Prompt, which act on the document. */}
          <button
            type="button"
            data-tour="describe"
            className={`canvas-describe${describing ? " is-open" : ""}`}
            title={
              describing
                ? "Close the assistant and go back to editing by hand"
                : "Describe a change in words; a local CLI proposes it, you apply it"
            }
            onClick={toggleAssistant}
          >
            <i aria-hidden="true">{describing ? "⚙" : "✎"}</i>
            {describing ? "Edit manually" : "Describe a change"}
          </button>

          {/* The canvas's top edge, as one column: the origin and counts on
              the left, the plaque and live chip on the right, wrapping onto a
              second row rather than drawing over each other, and the handover
              notice under whatever that takes (ANT-160). Floating rather than
              in the layout: the exchange is re-read on a timer, so the notice
              can appear while nobody is interacting, and the canvas must not
              jump under the reader's cursor when it does. */}
          <div className="canvas-top">
            <div className="canvas-top-row">
              <div className="canvas-chips">
                {handover ? (
                  <span className="canvas-origin from-session" title={`Handed over · ${workflow.name}`}>
                    <i aria-hidden="true" />
                    <span className="canvas-origin-name">Handed over · {workflow.name}</span>
                  </span>
                ) : null}
                <span className="pill">
                  {workflow.nodes.length} blocks · {outputCount} connections ·{" "}
                  {cycles.length} {cycles.length === 1 ? "loop" : "loops"}
                </span>
              </div>
              {/* One cluster in the canvas's own coordinates: the plaque explains,
                  the chip claims. Both sit outside the layer that pans and zooms,
                  so neither drifts with the diagram. */}
              <div className="canvas-presence">
                {watched ? <PresencePlaque presence={presenceKey(watched)} {...(watched.exchange && watched.state === "pending_after_copy" ? { note: "revision bound; no progress evidence yet" } : {})} /> : null}
                <LiveIndicator
                  {...(workflow.id ? { workflowId: workflow.id } : {})}
                  onOpenSession={(run, capability) => {
                    openLive(run);
                    setLiveObservation(capability);
                  }}
                />
              </div>
            </div>
            {handover?.model.notice ? <HandoverNotice notice={handover.model.notice} /> : null}
          </div>

          <div className="canvas-legend">
            <span>
              <i className="legend-line" style={{ borderColor: "#7d7979" }} /> next
            </span>
            <span>
              <i
                className="legend-line"
                style={{ borderColor: "#d8a21a", borderTopStyle: "dashed" }}
              />{" "}
              rework
            </span>
            <span>
              <i
                className="legend-line"
                style={{ borderColor: "#56aee0", borderTopStyle: "dotted" }}
              />{" "}
              question
            </span>
            {/* Drawn on the canvas, so it has its entry here (W2, ANT-178). */}
            <span>
              <i
                className="legend-line"
                style={{ borderColor: "#ec3013", borderTopStyle: "dashed" }}
              />{" "}
              stop
            </span>
          </div>
        </div>

        <aside className="inspector" data-tour="inspector">
          {/* The assistant replaces the inspector outright rather than sitting
              beside it as a tab: while it is open a canvas click references a
              block instead of selecting one, so there is nothing for an
              inspector to be showing. */}
          {describing ? (
            <DescribeChangeAssistant
              workflow={workflow}
              mentions={mentions}
              onMentionsChange={setMentions}
              onApply={(next) => editWorkflow(next)}
              onClose={toggleAssistant}
            />
          ) : (
            <>
          <header className="inspector-top">
            <h2>{inspecting.title}</h2>
            {inspecting.count ? <span className="count">{inspecting.count}</span> : null}
          </header>

          {selectedAgentProfile ? (
            <AgentEditor
              key={selectedAgentProfile.id}
              workflow={workflow}
              profile={selectedAgentProfile}
              onChange={editWorkflow}
              onSelect={setSelectedAgent}
              onSelectStep={selectStep}
              {...(returnStep
                ? {
                    backTo: {
                      label: returnStep.name || "the step",
                      go: () => selectStep(returnStep.id),
                    },
                  }
                : {})}
            />
          ) : selection.kind === "output" ? (
            <OutputInspector
              workflow={workflow}
              nodeId={selection.nodeId}
              outputId={selection.outputId}
              onChange={editWorkflow}
              onStartLinking={startLinking}
              onCleared={() => setSelection(NO_SELECTION)}
              onSelectStep={selectStep}
              validation={validation}
            />
          ) : selectedNode ? (
            <BlockInspector
              workflow={workflow}
              node={selectedNode}
              onChange={editWorkflow}
              onStartLinking={startLinking}
              onSelectOutput={(nodeId, outputId) =>
                setSelection({ kind: "output", nodeId, outputId })
              }
              onEditAgent={(agentId) => editAgent(agentId, selectedNode.id)}
              onSelectStep={selectStep}
              validation={validation}
            />
          ) : (
            <div className="inspector-idle">
              <h3>Nothing selected</h3>
              <p>Pick a block or a connection on the canvas, or an agent from the library.</p>
              <div className="chips">
                <span className="chip">
                  {workflow.nodes.length} {workflow.nodes.length === 1 ? "block" : "blocks"}
                </span>
                <span className="chip">
                  {agents.length} {agents.length === 1 ? "agent" : "agents"}
                </span>
                {validation.errors.length > 0 ? (
                  <span className="chip error">{validation.errors.length} to fix</span>
                ) : (
                  <span className="chip ok">nothing to fix</span>
                )}
              </div>
            </div>
          )}
            </>
          )}
        </aside>
      </div>

      <footer className="statusbar">
        {path ? (
          <RevealPath path={path} platform={host.platform} home={host.home} onReveal={() => void reveal()} />
        ) : (
          // Only a blank workflow gets here, until it is named or saved:
          // everything else has its JSON in the folder from the start.
          <span className="path">Not saved yet</span>
        )}
        <span className="spacer" />
        <span>
          {workflow.target ? HARNESS_PROFILES[workflow.target].displayName : "No harness"}
        </span>
        <span>
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </span>
        <span>
          {cycles.length === 0
            ? "no loops"
            : `${cycles.length} ${cycles.length === 1 ? "loop" : "loops"}`}
        </span>
      </footer>

      {revealError ? (
        <div className="reveal-toast" role="alert">
          {revealError}
        </div>
      ) : null}

      {/* The canvas tour (ANT-141): only once there is a canvas to point at,
          and only while it is due — after onboarding, or from Show tips. */}
      {touring ? (
        <CanvasTour
          steps={CANVAS_TOUR}
          onClose={() => {
            markTourSeen();
            setTouring(false);
          }}
        />
      ) : null}
    </div>
  );

  return (
    <>
      {liveRun ? (
        <LiveSessionPage
          key={liveRun.anthillRunId}
          workflow={workflow}
          run={current(liveRun)}
          storageError={liveStorageError}
          {...(liveObservation ? { observation: liveObservation } : {})}
          hidden={showing !== "live"}
          tabs={tabs}
          onExit={exit}
          onStopObserving={(runId) => {
            void window.anthill.liveCancel(runId);
            setLiveRun(null);
            setTab("workflow");
          }}
        />
      ) : null}
      {workflowShown.current ? workflowPage : null}
    </>
  );
}
