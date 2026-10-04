/**
 * The IPC contract between the Electron main process and the renderer.
 *
 * This file is the single source of truth for both sides and must not import
 * anything from `electron`, `node:*`, or the renderer — it is pure types plus
 * channel-name constants, so it can be safely pulled into either bundle.
 *
 * Security boundary: the renderer has no Node integration. Everything that
 * touches the filesystem, git, or spawns an agent CLI happens in main and is
 * reachable only through the channels named here.
 */

import type { ExternalLink } from "./links.js";
import type { Workflow, WorkflowRun, NodeRun } from "@anthill/workflow-schema";
import type { AgentModels, InterpreterId, ModelPreferences, CheckedPluginHarness } from "@anthill/workflow";
import type { LiveSessionState, MarkerCli, ObservationEvent, PendingRun } from "@anthill/live";
import type { BoundWorkflowResult, ExchangeView } from "@anthill/workflow-exchange";

export type { LiveSessionState, MarkerCli, ObservationEvent, PendingRun };

/* ------------------------------------------------------------------ */
/* Request/response channels (renderer -> main, via ipcRenderer.invoke) */
/* ------------------------------------------------------------------ */

export const IpcChannel = {
  appCapabilities: "app:capabilities",
  appRelaunch: "app:relaunch",
  appQuit: "app:quit",
  workflowOpen: "workflow:open",
  workflowPendingOpen: "workflow:pending-open",
  workflowOpened: "workflow:opened",
  exchangeRead: "exchange:read",
  liveWorkflow: "live:workflow",
  workflowSave: "workflow:save",
  runList: "run:list",
  runGet: "run:get",
  workflowExport: "workflow:export",
  workflowSetDirty: "workflow:set-dirty",
  workflowSetRevealable: "workflow:set-revealable",
  recentsList: "recents:list",
  recentsForget: "recents:forget",
  interpretersDetect: "interpreters:detect",
  codexModels: "codex:models",
  piModels: "pi:models",
  promptDraft: "prompt:draft",
  promptDraftCancel: "prompt:draft-cancel",
  promptFolderChoose: "prompt:folder-choose",
  liveObserve: "live:observe",
  liveSnapshot: "live:snapshot",
  liveCancel: "live:cancel",
  liveDismiss: "live:dismiss",
  liveLookAgain: "live:look-again",
  liveLastRun: "live:last-run",
  agentsList: "agents:list",
  agentsCreate: "agents:create",
  agentsUpdate: "agents:update",
  agentsDuplicate: "agents:duplicate",
  agentsRemove: "agents:remove",
  assistantThreadRead: "assistant:thread-read",
  assistantThreadWrite: "assistant:thread-write",
  assistantThreadClear: "assistant:thread-clear",
  modelPreferencesRead: "model-preferences:read",
  modelPreferencesWrite: "model-preferences:write",
  pluginStatus: "plugins:status",
  pluginConnections: "plugins:connections",
  pluginInstall: "plugins:install",
  pluginGuide: "plugins:open-guide",
  linkOpen: "link:open",
  settingsRead: "settings:read",
  settingsWrite: "settings:write",
  diagnosticsRendererError: "diagnostics:renderer-error",
  notificationsProbe: "settings:notifications-probe",
  liveEvents: "live:events",
  liveSetupStatus: "live-setup:status",
  liveSetupDismiss: "live-setup:dismiss",
  liveSetupDecline: "live-setup:decline",
  liveSetupInstall: "live-setup:install",
  liveSetupDisable: "live-setup:disable",
  folderChoose: "folder:choose",
  workflowFolderChoose: "settings:choose-workflow-folder",
  interpreterSignIn: "interpreters:sign-in",
  pathsCheck: "paths:check",
  pathReveal: "path:reveal",
} as const;

/* ------------------------------------------------------------------ */
/* Process compatibility                                               */
/* ------------------------------------------------------------------ */

/**
 * What this build of the contract offers.
 *
 * Three pieces of Anthill are loaded from three different places and can end up
 * at three different ages. The renderer comes from the dev server or the bundle
 * and is always current. The preload is read from disk every time a window
 * loads, so it changes the moment someone rebuilds. The main process is loaded
 * once when the app starts and then stays as it was — which is how a renderer
 * asking for a channel a running main has never heard of becomes possible.
 *
 * That mismatch used to be invisible: `ipcRenderer.invoke` on an unregistered
 * channel rejects, a rejection nobody awaited is swallowed, and a feature just
 * quietly showed nothing. Bump this whenever a channel is added, and the
 * renderer can find out before it subscribes to something that will never fire.
 *
 * A channel whose shape or meaning changes counts as much as a new one. The
 * hazard is the same — a renderer talking to a main process that answers a
 * different question — and it is harder to see, because both sides still have
 * the channel and nothing rejects.
 */
/*
 * 20: the runner's five request channels and its push channel went, the export
 * receipt gained `rolledBack`, and the live snapshot gained `storageError`.
 * The number stayed at 19 through all of it, which is the one thing this
 * constant exists not to do.
 */
// 21: project-aware observation checks, light refresh, native trust and shared opt-out.
/*
 * 22: model preferences (read, write) and the plugin status, for the three
 * Settings pages ANT-135 added.
 */
/*
 * 23: the plugin connections, the install that runs the tools' own plugin
 * commands, and the install guide a missing tool opens (From a session).
 */
// 24: choosing the workflow folder on Settings ▸ General, and the setting it writes.
// 25: the platform in the capabilities, and quitting from the Windows gate (ANT-154).
// 26: Edit ▸ Undo / Redo sent to the page (ANT-192).
// 27: the run a workflow last had, after the live store dropped it (ANT-275).
export const IPC_CONTRACT = 27;

export type IpcCapabilities = {
  /** The main process's own contract number. */
  contract: number;
  /** Every channel the running main process actually registered a handler for. */
  channels: string[];
  /**
   * Which shell is serving the renderer.
   *
   * The renderer is the same bundle in both shells; this is how it finds
   * out whether the harness it is about to instruct can reach the Anthill
   * CLI. The CLI shell says `cli`, and its prompts therefore tell the
   * harness to report through `anthill run` / `anthill step`. The desktop
   * shell says `desktop`, and its prompts keep the printed marker lines.
   * Additive: an old renderer that does not read it is unaffected, and an
   * old main process that does not send it is read as `desktop`.
   */
  shell?: "desktop" | "cli";
  /**
   * The operating system the shell runs on, as Node names it (`darwin`,
   * `linux`, `win32`). Windows is an unsupported, experimental source build
   * (ANT-154), and the renderer says so; absent from an older shell, which is
   * read as nothing to say.
   */
  platform?: string;
  /**
   * The home directory of the user the shell runs as, so the renderer can
   * show a path as `~/…` (ANT-206). Absent from an older shell, whose paths
   * are shown in full.
   */
  home?: string;
  /**
   * Whether this shell started with error reporting on. The CLI's page reads
   * it to decide whether to catch its own errors; the desktop tells its
   * renderer through the preload instead.
   */
  errorReports?: boolean;
};

/**
 * The channels the Live Session page needs before it can promise anything.
 *
 * Named here rather than in the page so that adding a channel and forgetting to
 * require it is a change in one file, not a silent gap in another.
 */
export const LIVE_SESSION_CHANNELS: readonly string[] = [
  IpcChannel.liveSnapshot,
  IpcChannel.liveEvents,
  IpcChannel.liveLookAgain,
];

/** Push channel (main -> renderer). Coarse progress for one drafting run. */
export const PROMPT_DRAFT_STAGE_CHANNEL = "prompt:draft-stage";

/** Push channel (main -> renderer). The current state of every observed run. */
export const LIVE_SNAPSHOT_CHANNEL = "live:snapshot-changed";

/** Push channel (main -> renderer). One run's observed activity, as it grows. */
export const LIVE_EVENTS_CHANNEL = "live:events-changed";

/**
 * The user asked for Settings, from the menu bar rather than from the page.
 *
 * Live Observation moved into the Prompt flow, where it is offered in the
 * order it is needed. Managing it afterwards — inspect, repair, disable — is a
 * different job with no place in that flow, so it is reached deliberately
 * through ⌘, instead.
 */
export const OPEN_SETTINGS_CHANNEL = "app:open-settings";

/**
 * The File menu asking the focused window to save what it has open.
 *
 * Save lives in the menu rather than in a renderer key handler so that one
 * press is one save: an accelerator is consumed before the page sees the key,
 * which also settles ⌘S never reaching the browser's own Save Page (ANT-59).
 */
export const SAVE_WORKFLOW_CHANNEL = "app:save-workflow";
export const REVEAL_WORKFLOW_CHANNEL = "app:reveal-workflow";

/**
 * Edit ▸ Undo or Redo, for the page to apply to what it is editing (ANT-192).
 *
 * The menu's own Undo took ⌘Z before the page saw it — an accelerator is
 * consumed first, as with ⌘S — and undid nothing outside a text field, so
 * the canvas shortcut was dead in the app. The menu now does the text field's
 * undo itself and tells the page; the page steps its history when no text
 * field has focus.
 */
export const EDIT_HISTORY_CHANNEL = "app:edit-history";

/**
 * A workflow a harness handed over, ready for the page to show.
 *
 * Nobody in the renderer asked for this one: it arrives because a coding tool
 * put a workflow in the exchange, or because the user followed an `anthill://`
 * link. The payload is the path of the working copy, so the page opens it
 * through the ordinary Open route and nothing about loading a document has to
 * know where it came from.
 *
 * A push alone would not do, because a page that has not mounted yet cannot be
 * sent anything and a link is at its most likely on a cold start. So main holds
 * what it could not deliver and the page collects it with
 * `IpcChannel.workflowPendingOpen` when it is ready; this channel carries
 * everything that arrives afterwards, while the page is up and listening.
 */
export const OPEN_WORKFLOW_CHANNEL = "app:open-workflow";

/**
 * A handover that could not be carried out, said to the page (ANT-228).
 *
 * The web shell's only. The desktop says the same thing in a native box, and
 * a browser tab has no process of its own to put one up, so the web shell
 * pushes the sentence and its page shows it. The payload is the message.
 */
export const HANDOVER_REFUSED_CHANNEL = "app:handover-refused";

/* ------------------------------------------------------------------ */
/* Payload shapes                                                      */
/* ------------------------------------------------------------------ */

/** Serializable view of the selected workspace. */
/** A reusable agent profile from the global library. Identity is the issued
 * id — never the name — and nothing about a profile executes anything. */
export type GlobalAgentProfile = {
  id: string;
  name: string;
  /**
   * The model chosen for each coding tool, for the tools somebody has answered
   * for.
   *
   * A library profile has no harness of its own — it is written before there is
   * a workflow to put it in — so it can hold a Claude Code answer, a Codex
   * answer, both, or neither, and the two are never translated into each
   * other's terms. Absent means nobody has answered for that tool, which is a
   * different fact from answering "inherit". See `agent-models.ts` in
   * @anthill/workflow.
   */
  models?: AgentModels;
  /**
   * A stored answer the author has to settle, kept verbatim.
   *
   * Not guessed at and not dropped: it is their own choice, and the only
   * honest thing to do with one whose meaning is ambiguous is show it back
   * and ask.
   */
  modelNeedsReview?: string;
  role?: string;
  description?: string;
  /**
   * Shipped with Anthill rather than written here.
   *
   * Provenance, not a kind: a ready-made profile opens and edits exactly like
   * one somebody wrote, and this changes only which group it is listed under.
   * The alternative — copying it on click — produced two rows with the same
   * name after one click and left the original permanently uncorrectable.
   */
  starter?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GlobalAgentInput = {
  name: string;
  /**
   * The whole per-tool bag, replaced rather than merged.
   *
   * The absence of a tool's key is the message — "nobody has answered for this
   * one" — and a patch that only ever added keys could not send it. An empty
   * bag clears the lot.
   */
  models?: AgentModels;
  role?: string;
  description?: string;
};

export type WorkspaceInfo = {
  rootPath: string;
  activePath: string;
  mode: string;
  git?: {
    repositoryRoot: string;
    branch?: string;
  };
};

export type WorkspaceStatus = {
  /** Raw `git status --porcelain` output; `undefined` outside a git repo. */
  status?: string;
  /** True when the workspace has uncommitted changes. Always false outside git. */
  dirty: boolean;
};

/** One runtime adapter and whether it can actually be used on this machine. */
export type RuntimeInfo = {
  id: string;
  displayName: string;
  available: boolean;
  version?: string;
  reason?: string;
};

export type OpenedWorkflow = {
  /** The workflow's JSON: for a handover, its export in the workflow folder. */
  path: string;
  /** Set for a handover: its exchange working copy, which Save also records. */
  exchangePath?: string;
  workflow: Workflow;
  /** Set when the workflow loaded but predates this build's format. */
  notice?: string;
};

/**
 * Opening can fail for a reason the user needs explained — a workflow from a newer
 * build, or a file that is not a workflow at all. Returned rather than thrown so
 * the renderer can show the real reason instead of a generic schema error.
 *
 * `cancelled` with `candidates` is the CLI's answer to the desktop's file
 * dialog: there is no dialog to show, so the CLI offers the workflow files it
 * knows about (the recents and the files in the configured workspace) and the
 * renderer lets the author pick one. A `cancelled` without `candidates` is a
 * genuine cancellation (the desktop's dialog was dismissed).
 */
export type OpenWorkflowResult =
  | { ok: true; opened: OpenedWorkflow }
  | { ok: false; cancelled: true; candidates?: string[] }
  | { ok: false; error: string };

export type SaveWorkflowRequest = {
  workflow: Workflow;
  /**
   * Where the last successful save went, if it went anywhere.
   *
   * Desktop Save writes back into it when it is in the workflow folder. A
   * file elsewhere is asked about once: overwrite it, or save a copy in the
   * folder. The filename never follows a rename.
   */
  path?: string;
  /** Granted exchange working copy, retained when desktop Save exports JSON. */
  exchangePath?: string;
  /**
   * A save Anthill makes on the author's behalf: a new workflow's first file
   * as soon as it has a title, or one copied from the prompt (ANT-177). It
   * never asks, so a save that would have to ask is not made.
   */
  quiet?: boolean;
};

/**
 * What the app knows of one handed-over workflow, and what a bound run is
 * working from. Defined beside the exchange contract, where the app side of
 * the protocol (`@anthill/exchange-host`) can use them without the desktop.
 */
export type { BoundWorkflowResult, ExchangeView } from "@anthill/workflow-exchange";

/**
 * How a save ended, in the three ways an author can be told apart.
 *
 * A bare path-or-null could not distinguish "you cancelled the dialog" from
 * "the disk refused it", so the editor had nothing true to show for either and
 * showed nothing at all (ANT-58). Failure carries its reason because a message
 * the author can act on is the whole point of reporting one.
 */
export type SaveWorkflowResult =
  | { kind: "saved"; path: string; exchangePath?: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

export type StartRunRequest = {
  workflow: Workflow;
  /** Working directory agent nodes run in, unless a node overrides it. */
  workspacePath: string;
};

export type StartRunResponse =
  | { ok: true; runId: string }
  | { ok: false; error: string };

export type ApprovalDecision = "approved" | "rejected";

export type ApprovalResponse = {
  runId: string;
  nodeId: string;
  decision: ApprovalDecision;
};

/** A run plus the workflow snapshot it started from. */
export type StoredRunView = WorkflowRun & {
  snapshot: Record<string, unknown>;
};

/* ------------------------------------------------------------------ */
/* Workflow                                                             */
/* ------------------------------------------------------------------ */

/** One generated file, as produced by `@anthill/workflow`. */
export type WorkflowFile = {
  /** Repository-relative path, e.g. `.claude/agents/reviewer.md`. */
  path: string;
  content: string;
};

export type ExportWorkflowRequest = {
  files: WorkflowFile[];
  /** Written alongside the agent files when set, so the prompt is kept too. */
  prompt?: string;
  /**
   * Where to write, when the author has already said. Absent asks them.
   *
   * A repository chosen once and remembered is the whole point: a harness only
   * offers agents that were on disk before its session began, so the files have
   * to be written every time the prompt is copied — and a folder dialog on
   * every copy is a step someone skips exactly once.
   */
  root?: string;
};

export type ExportWorkflowResponse =
  | { ok: true; directory: string; written: string[] }
  | {
      ok: false;
      error: string;
      /**
       * Whether the folder was put back as it was found.
       *
       * The difference the author has to act on. A rolled-back export is a
       * thing that did not happen; one that could not be undone has left a
       * mixture of old and new generated files in a folder they are about to
       * use (ANT-100).
       */
      rolledBack?: boolean;
    }
  | { ok: false; cancelled: true };

/* ------------------------------------------------------------------ */
/* Events (main -> renderer)                                           */
/* ------------------------------------------------------------------ */

export type RunEvent =
  | { type: "run-created"; run: WorkflowRun }
  | { type: "node-updated"; runId: string; nodeRun: NodeRun }
  | { type: "run-updated"; run: WorkflowRun }
  | {
      type: "run-finished";
      run: WorkflowRun;
      /** Populated when the run ended in `failed`/`cancelled`. */
      failure?: { code: string; message: string; nodeId: string };
    }
  | {
      type: "approval-requested";
      runId: string;
      nodeId: string;
      context: Record<string, unknown>;
    };

/**
 * A workflow this machine has open recently, as the launch window shows it.
 *
 * `meta` is read from the file rather than cached, so a workflow edited elsewhere
 * still describes itself correctly.
 */
export type RecentWorkflow = {
  path: string;
  /** The workflow's own id, so a live observation can be matched to its file. */
  workflowId?: string;
  /**
   * How this workflow's last observed run ended, when one did and Anthill
   * still remembers it.
   *
   * Only ever an ending — finished, failed, or observation lost. Anything
   * being watched right now comes from the live snapshot instead, so the two
   * never argue: this answers only for a workflow with no live run left.
   *
   * It exists because the live store is a working set that drops a settled run
   * a day later, which turned every row grey a day after it was last used
   * (ANT-84).
   */
  /** `unclaimed`: no session ever carried the copied prompt (ANT-212). */
  lastRun?: { state: LiveSessionState; at: string; stopped?: boolean; unclaimed?: boolean };
  /**
   * Step id → step name, for the workflows in this list.
   *
   * Carried because the launch window has no workflow loaded and still has to say
   * *which* step a live session is on. The file is parsed here anyway; a
   * handful of names costs nothing next to reading it twice.
   */
  steps?: Record<string, string>;
  /**
   * The global library profiles this workflow holds a copy of.
   *
   * So the agent library can say which workflows would be left holding an
   * orphaned copy before a profile is deleted, without opening every file
   * again at the moment the question is asked.
   */
  libraryAgentIds?: string[];
  /** Home-relative, because `~/workflows/x.json` is readable and the full path is not. */
  displayPath: string;
  name: string;
  /** "5 blocks · 2 agents · Claude Code". */
  meta: string;
  modifiedAt: string;
};

/**
 * A local CLI Anthill can ask to draft a workflow from a prompt.
 *
 * `command` is the exact invocation, shown to the author before anything runs;
 * `boundary` says in plain words what that invocation can and cannot do. Both
 * are carried in the contract rather than written in the renderer so the UI
 * cannot describe a command different from the one main actually runs.
 */
export type InterpreterInfo = {
  id: InterpreterId;
  label: string;
  command: string;
  boundary: string;
  /** What it can and cannot do once it is given a project folder to read. */
  folderBoundary: string;
  available: boolean;
  /**
   * Whether the CLI says somebody is signed in. Absent when the question could
   * not be answered — which is not the same as a no, and must not be shown as
   * one.
   */
  signedIn?: boolean;
  version?: string;
  /** Why it cannot be used, when it cannot. */
  reason?: string;
};

/** One model Codex offers, as Codex's own catalogue describes it. */
export type CodexModelOption = {
  /** The slug written into an agent file's `model`. */
  id: string;
  label: string;
  hint?: string;
  /** The reasoning levels this model supports, in Codex's own order. */
  efforts: { id: string; hint?: string }[];
  defaultEffort?: string;
};

/**
 * What Codex last listed for this machine.
 *
 * Evidence about the account rather than about a version — but it is a cache
 * with a timestamp, not a live check, so `fetchedAt` travels with it and the
 * screen says when Codex last looked instead of claiming a model is available
 * now.
 */
/**
 * Anthill's plugin in one coding tool, as that tool's own records describe it
 * (ANT-135). Read from files the tool keeps, never by running it.
 */
export type PluginHarnessStatus = {
  harness: CheckedPluginHarness;
  label: string;
  /** The plugin's name in that tool: `anthill` in every tool. */
  plugin: string;
  /** The tool's own directory exists, so it has been used on this machine. */
  toolFound: boolean;
  installed: boolean;
  /** Installed and not switched off. */
  enabled: boolean;
  installedVersion?: string;
  /** The marketplace it was installed from. */
  marketplace?: string;
  /** Where that marketplace comes from: a path, a repository, a URL. */
  source?: string;
  /** A local Anthill checkout offered as a marketplace, when one is known. */
  checkout?: string;
  /** What that checkout would install now. */
  availableVersion?: string;
};

/** Whether the launcher both plugins ship can find the MCP server it runs. */
export type PluginServerStatus = {
  /** `~/.anthill/plugin.json` exists and names a server. */
  configured: boolean;
  settingsFile: string;
  path?: string;
  exists?: boolean;
  problem?: string;
};

export type PluginStatus = {
  harnesses: PluginHarnessStatus[];
  server: PluginServerStatus;
};

/**
 * Everything one plugin card needs to say where a tool stands, in one answer.
 *
 * The records (`status`) say what the tool wrote down; the rest is what those
 * records cannot: whether the CLI actually runs, whether Anthill has somewhere
 * to install the plugin *from*, and whether the server the installed plugin
 * launches really answers. A card that turned green on an install record alone
 * would be claiming a connection nobody tested.
 */
export type PluginConnection = {
  harness: CheckedPluginHarness;
  label: string;
  /** The tool's CLI runs on this machine, and says which version it is. */
  cli: { available: boolean; version?: string };
  status: PluginHarnessStatus;
  /**
   * Where Anthill installs the plugin from: a local Anthill checkout when
   * there is one, otherwise the repository on GitHub (`anthillapp/anthill`).
   * Optional for older main processes, which left it out without a checkout;
   * the card then sends the author to Settings ▸ Plugins instead.
   */
  source?: string;
  /**
   * Whether the installed plugin's launcher started Anthill's server and it
   * answered an MCP handshake. Absent when there was nothing to ask — the
   * plugin is not installed, or not switched on.
   */
  serverAnswers?: boolean;
  /** Why the server did not answer, in the launcher's own words when it gave any. */
  serverProblem?: string;
};

/** What an install did. `changed` says whether anything moved on disk before it stopped. */
export type PluginInstallResult =
  /**
   * `confirm`: the tool's own install links were opened, and the tool asks the
   * person before it installs anything. Nothing is installed until they say so.
   */
  | { ok: true; confirm?: boolean }
  | { ok: false; error: string; changed: boolean };

export type CodexModelCatalog = {
  models: CodexModelOption[];
  fetchedAt?: string;
  /**
   * Whether the `codex` on this PATH reads `.codex/agents/*.toml` at all.
   *
   * Not a version comparison — the binary is asked about itself. `unknown` is
   * a real answer and never means "no": telling somebody to update software
   * that is already fine is the one wrong direction here.
   */
  agentSupport: "supported" | "unsupported" | "unknown";
};

/** One model pi offers, as `pi --list-models` reports it. */
export type PiModelOption = {
  /** The pattern written to `--model`: `provider/model`. */
  id: string;
  label: string;
  /**
   * The thinking levels this model can run at.
   *
   * pi's levels are fixed by `--thinking`, not per-model, so a thinking-
   * capable model offers the whole set and a non-thinking one offers none.
   * `off` is omitted — it is the same as the UI's "inherit".
   */
  efforts: { id: string; hint?: string }[];
};

/**
 * What pi listed for this machine.
 *
 * Read live with `pi --list-models` — pi keeps no model cache file, so there
 * is no `fetchedAt` and no stale-cache caveat. `undefined` (not an empty
 * list) when the CLI could not be reached.
 */
export type PiModelCatalog = {
  models: PiModelOption[];
};

/** The preferences Anthill keeps for this machine. Documented in main/settings.ts. */
export type AppSettings = {
  /** Anonymous product analytics for the packaged macOS desktop app. Off by default. */
  analyticsEnabled: boolean;
  /** JavaScript error reports, from the next app launch. Off by default. */
  errorReportingEnabled: boolean;
  /** Native memory dumps, from the next app launch. Off by default. */
  nativeCrashReportingEnabled: boolean;
  /** Native notification on a confidently observed move to a new step. Off by default. */
  stepNotifications: boolean;
  /** …on a step the session left behind. */
  stepFinishedNotifications: boolean;
  /** …on a step announced again — a loop coming back round. */
  loopNotifications: boolean;
  /** …when the CLI records that it is waiting for a person. */
  needsYouNotifications: boolean;
  /** …when the session finishes, or the record says it failed. */
  finishedNotifications: boolean;
  /** …when Anthill can no longer read the session. */
  observationLostNotifications: boolean;
  /**
   * Where the save dialog opens for a workflow that has never been saved.
   * An absolute path, or empty for the default, `~/Documents/Anthill`.
   */
  workflowFolder: string;
};

/** How the default workflow folder is shown; main resolves it against the home folder. */
export const DEFAULT_WORKFLOW_FOLDER = "~/Documents/Anthill";

/**
 * What happened when a test notification was sent.
 *
 * "sent" means the app handed it to the system, which is everything it can
 * know — whether it appeared is the thing the author is being asked to look
 * for.
 */
export type NotificationProbe = { kind: "sent" } | { kind: "unsupported"; reason: string };

export type PromptDraftRequest = {
  interpreterId: InterpreterId;
  /** The full drafting instruction, built in the renderer from the author's prompt. */
  instruction: string;
  /**
   * A project folder the CLI may read, read-only (ANT-67). Main runs it there
   * only if its own folder picker returned this path in this session.
   */
  folder?: string;
};

/** A project folder the author picked for drafting, and how to show it. */
export type DraftFolder = {
  /** Absolute and real, as main resolved it. */
  path: string;
  /** With the home directory shown as `~`. */
  displayPath: string;
};

/**
 * How far a drafting run has got, as far as main can honestly say.
 *
 * Coarse on purpose. The CLI's own output is not relayed: it is the model's
 * working, and showing it would both leak reasoning and imply that Anthill has
 * recognised parts of a workflow before any valid draft exists.
 */
export type PromptDraftStage = "preparing" | "analyzing" | "replying";

/** The CLI's raw reply. Parsing and validation happen in `@anthill/workflow`. */
export type PromptDraftResponse =
  | { ok: true; reply: string; command: string }
  | {
      ok: false;
      error: string;
      command: string;
      cancelled?: undefined;
      /**
       * The CLI's own sign-in has expired, and nothing else is wrong.
       *
       * Carried apart from `error` because it is the one failure with a
       * recovery the app can offer: it opens the CLI's own login. Relaying the
       * CLI's sentence and nothing else left the author reading
       * "exited with code 1: Failed to authenticate" with no way forward
       * (ANT-111).
       *
       * Set only when the CLI itself says so — `claude auth status` is asked,
       * not guessed at from the wording, which belongs to the CLI and will
       * change.
       */
      signedOut?: InterpreterId;
      /**
       * The project folder is gone, so nothing was run. The fix is in the
       * folder block, not in the prompt, so the screen sends the author there.
       */
      folderMissing?: true;
    }
  /** The author cancelled. Not an error, and not shown as one. */
  | { ok: false; cancelled: true; command: string; error?: undefined };

/* ------------------------------------------------------------------ */
/* Live session auto-detection                                         */
/*                                                                     */
/* Anthill does not run anything here. The user copies a prompt, starts */
/* it themselves in their own CLI, and Anthill recognises the session   */
/* afterwards from the records that CLI writes locally. Nothing in this */
/* contract can start, stop, or steer a session, because Anthill has no */
/* such power over one it did not launch.                              */
/* ------------------------------------------------------------------ */

/** What one local CLI does and does not expose for observation. */
export type LiveObserverCapabilities = {
  cli: MarkerCli;
  available: boolean;
  root: string;
  note: string;
  reportsCompletion: boolean;
  reportsFailure: boolean;
};

export type LiveSnapshot = {
  storageError?: string;
  /** Runs worth showing, newest first. */
  runs: PendingRun[];
  capabilities: LiveObserverCapabilities[];
};

/**
 * Start observing for the session a copied prompt will produce.
 *
 * Sent immediately before the prompt reaches the clipboard, so the record
 * exists even if the app is closed between the copy and the paste.
 */
export type LiveObserveRequest = {
  anthillRunId: string;
  correlationNonce: string;
  selectedCli: MarkerCli;
  promptVersion: string;
  /** A hash of the copied prompt. The prompt itself is never sent or stored. */
  bootstrapPromptHash: string;
  workflowId?: string;
  workflowName?: string;
  /**
   * The steps the marker named, as they were called when the prompt was copied.
   *
   * Sent because the workflow lives in the editor and a run outlives the screen
   * that started it: without these a transition can only be reported as a block
   * id, which is not something to put in a notification. Gates are marked:
   * a turn that ends on one is waiting for a person (ANT-210).
   */
  steps?: { id: string; name: string; gate?: true }[];
};

/* ------------------------------------------------------------------ */
/* Local observation setup                                             */
/*                                                                     */
/* This is setup for passive observation hooks only. The install/disable */
/* calls mutate local CLI hook configuration after explicit user action; */
/* they do not start agents, attach to sessions, or change permissions.  */
/* ------------------------------------------------------------------ */

export type CodexHookStatus = {
  state: "needs-trust" | "disabled" | "not-loaded" | "unknown" | "ready";
  message: string;
  requiresHostAccess?: boolean;
  /**
   * A hook of Anthill's has already fired in the Codex session asking. The
   * strongest answer there is — it is working, here — and the one that needs
   * no call into Codex, which a sandboxed agent cannot make (ANT-138).
   */
  confirmedInSession?: boolean;
};

/**
 * What to ask the person about hooks now, if anything (ANT-138): connect them,
 * trust them in Codex's /hooks, or read a hint about a check that could not
 * say. One rule for both ways a Codex workflow starts.
 */
export type ObservationPrompt = "connect" | "trust" | "hint";

export type ObservationHarnessSetup = {
  id: MarkerCli;
  label: string;
  cliCommand: string;
  cliAvailable: boolean;
  version?: string;
  reason?: string;
  /**
   * Entries pass structural checks. This installation's handler is probed;
   * another installation's command is never executed from configuration.
   * `hookUsesCurrentRuntime` distinguishes those cases. Codex permissions and
   * received events are checked separately.
   */
  hookInstalled: boolean;
  hookUsesCurrentRuntime?: boolean;
  hookInstallProblem?: string;
  /** Codex's own permission check; a runnable handler alone is not ready. */
  codexHooks?: CodexHookStatus;
  observationDeclined?: boolean;
  /** What to ask now, or nothing. See `ObservationPrompt`. */
  observationPrompt?: ObservationPrompt | null;
  /** The entries are in the config file, whatever running them does. */
  hookEntriesPresent: boolean;
  /** Why the handler could not run, when entries are present but it cannot. */
  hookProblem?: string;
  /**
   * When an event from this harness last arrived in the hook log.
   *
   * The difference between a hook that runs and a hook the harness runs. A
   * command Anthill can execute, in a config file nothing reads, passes every
   * other check here and delivers nothing.
   */
  hookLastEventAt?: string;
  /** When Anthill wrote these entries, so silence can be given a length. */
  hookInstalledAt?: string;
  configPath: string;
  hookHandlerPath: string;
  installerAction: string;
  installCommand: string;
  hookCommands: string[];
  eventCategories: string[];
  localDataBoundary: string;
  changes: string[];
};

export type ObservationSetupStatus = {
  dismissed: boolean;
  trigger: string;
  harnesses: ObservationHarnessSetup[];
};

export type ObservationSetupActionResult =
  | { ok: true; status: ObservationSetupStatus; message: string; backupPath?: string }
  | { ok: false; status: ObservationSetupStatus; error: string; backupPath?: string };

/* ------------------------------------------------------------------ */
/* The API surface exposed on `window.anthill` by the preload script   */
/* ------------------------------------------------------------------ */

export interface AnthillApi {
  /** True only when error reporting was enabled at desktop launch. */
  readonly errorReportingAtLaunch?: boolean;
  /**
   * The contract version of the preload that answered, as a plain value.
   *
   * Read synchronously and without touching main, so a renderer newer than the
   * preload is detectable even when nothing can be invoked at all.
   */
  readonly contract: number;
  /**
   * What the running main process can actually do.
   *
   * Rejects when main is older than the preload that called it — which is the
   * signal the caller wants, not a failure to hide.
   */
  capabilities(): Promise<IpcCapabilities>;
  /**
   * Quit and start Anthill again, so a stale main process is replaced.
   *
   * Goes through the same unsaved-workflow guard as closing the window: a workflow with
   * unsaved edits asks first, and a refusal leaves the app running. Returns
   * `false` when the restart did not happen, so the caller can say so rather
   * than waiting for something that is not coming.
   */
  relaunch(): Promise<boolean>;
  /**
   * Quit Anthill, through the same unsaved-workflow guard as closing the
   * window. Only the desktop shell serves it; the CLI's page has nothing to quit.
   */
  quit?(): Promise<boolean>;
  /** With a path, opens that workflow; without one, asks the author to pick. */
  openWorkflow(path?: string): Promise<OpenWorkflowResult>;
  /**
   * The workflow Anthill was asked to show before this page could show one.
   *
   * Also announces that the page is listening. Current desktop builds retain
   * requests in their source queues and push them with delivery IDs after this
   * handshake; an older host may instead return a pending path once.
   */
  pendingWorkflowOpen(): Promise<string | undefined>;
  workflowOpened(path: string, deliveryId?: number, outcome?: "shown" | "declined" | "confirming" | "opening"): Promise<void>;
  exchangeRead(path: string, workflowId: string): Promise<ExchangeView | undefined>;
  liveWorkflow(runId: string): Promise<BoundWorkflowResult>;
  /**
   * A workflow a harness handed over while the page was up. Returns the
   * unsubscribe.
   *
   * The path of a working copy, to be opened through `openWorkflow`. Whether
   * the user wants this interruption is checked by the renderer immediately
   * before navigation, not against a stale document in main.
   */
  onOpenWorkflow(listener: (path: string, deliveryId?: number) => void): () => void;
  saveWorkflow(request: SaveWorkflowRequest): Promise<SaveWorkflowResult>;
  /** File ▸ Save, or ⌘S. Returns the unsubscribe. */
  onSaveWorkflow(listener: () => void): () => void;
  /** File ▸ Reveal in Finder (Show in Folder off macOS). Desktop only; returns the unsubscribe. */
  onRevealWorkflow?(listener: () => void): () => void;
  /**
   * Edit ▸ Undo or Redo, or ⌘Z / ⇧⌘Z (ANT-192). Absent where there is no
   * application menu — the CLI's browser page — and the keys reach the page.
   */
  onEditHistory?(listener: (action: "undo" | "redo") => void): () => void;
  listRuns(): Promise<WorkflowRun[]>;
  getRun(runId: string): Promise<StoredRunView | undefined>;
  /** Ask the user for a folder, then write the generated workflow files into it. */
  exportWorkflow(request: ExportWorkflowRequest): Promise<ExportWorkflowResponse>;
  /**
   * Ask for a folder without writing anything into it.
   *
   * Naming the repository and writing to it are separate moments now: the
   * author picks first and sees what is about to be put there, and only the
   * copy actually writes. `null` means they closed the dialog.
   */
  chooseRunFolder(): Promise<string | null>;
  /**
   * Ask for the folder new workflows are saved in, and keep it. The settings
   * as they now are, or null when the dialog was cancelled.
   */
  chooseWorkflowFolder(): Promise<AppSettings | null>;
  /**
   * Tell the main process whether the open workflow has unsaved edits, so closing
   * the window can ask before discarding them. The renderer cannot block a
   * window close on its own.
   */
  setWorkflowDirty(dirty: boolean): Promise<void>;
  /** Whether File ▸ Reveal in Finder has a saved JSON to show. Desktop only. */
  setWorkflowRevealable?(revealable: boolean): Promise<void>;
  /** Workflows opened recently, newest first. Ones that have gone are left out. */
  listRecentPlans(): Promise<RecentWorkflow[]>;
  /** Drop one from the list. The file itself is untouched. */
  forgetRecentWorkflow(path: string): Promise<void>;
  /**
   * Which of these paths exist on this machine.
   *
   * Asked by the message renderer about paths an *agent* wrote, so that a path
   * is only offered as clickable when there is something there to show. The
   * renderer never touches the filesystem itself; it asks, and main answers
   * with nothing but booleans.
   */
  /**
   * Open the author's terminal on this CLI's own sign-in command.
   *
   * Anthill does not sign anyone in and never sees a credential: the command
   * belongs to the CLI, the browser flow belongs to the author, and all this
   * does is put the command in front of them in a place where they can watch
   * it and answer it. Returns whether the terminal could be opened, so a
   * failure is reported rather than silently leaving nothing to look at.
   */
  signInToInterpreter(id: InterpreterId): Promise<{ ok: boolean; error?: string }>;
  pathsExist(paths: string[]): Promise<Record<string, boolean>>;
  /**
   * Show one item in Finder. Reveal, never open.
   *
   * The distinction is the whole point. `shell.openPath` on a path an external
   * agent wrote would run whatever that path turns out to be; revealing shows
   * it in its folder and executes nothing. Returns whether it was revealed, so
   * a caller is never left believing something happened that did not.
   */
  revealPath(path: string): Promise<boolean>;
  /** Which local CLIs are installed and could draft a workflow from a prompt. */
  detectInterpreters(): Promise<InterpreterInfo[]>;
  /**
   * Codex's own model catalogue, or `undefined` when Anthill has not been told.
   *
   * `undefined` rather than an empty list: the two say different things, and
   * "Codex offers no models" is not something a missing file is evidence for.
   */
  codexModels(): Promise<CodexModelCatalog | undefined>;
  /**
   * pi's model catalogue, read live with `pi --list-models`, or `undefined`
   * when the CLI could not be reached.
   *
   * `undefined` rather than an empty list: the two say different things, and
   * "pi offers no models" is not something a missing binary is evidence for.
   */
  piModels(): Promise<PiModelCatalog | undefined>;
  /**
   * Pick a project folder for a drafting run to read (ANT-67). Opens the
   * native folder picker; `null` when the author cancels it.
   */
  chooseDraftFolder(): Promise<DraftFolder | null>;
  /**
   * Run one drafting pass through a local CLI. Interpretation only: the process
   * gets no tools and an empty working directory — or, given a project folder,
   * read-only tools in that folder — and nothing it says is persisted until the
   * author accepts the preview.
   */
  draftFromPrompt(request: PromptDraftRequest): Promise<PromptDraftResponse>;
  /** Stop the drafting run in progress. Safe to call when none is. */
  cancelPromptDraft(): Promise<void>;
  /** Subscribe to drafting progress. Returns an unsubscribe function. */
  onPromptDraftStage(listener: (stage: PromptDraftStage) => void): () => void;
  /* Live session auto-detection */

  /**
   * Begin passive observation for a prompt about to be copied.
   *
   * Observation only: Anthill reads local records the user's own CLI writes.
   * There is deliberately no counterpart that starts, joins, or stops a session.
   */
  liveObserve(request: LiveObserveRequest): Promise<LiveSnapshot>;
  /** Everything currently observed, plus what each local CLI can expose. */
  liveSnapshot(): Promise<LiveSnapshot>;
  /**
   * Stop observing one run.
   *
   * This stops Anthill looking. It sends nothing to the user's session, which
   * keeps running exactly as it was.
   */
  liveCancel(runId: string): Promise<LiveSnapshot>;
  /** Hide a run that has already settled. */
  liveDismiss(runId: string): Promise<LiveSnapshot>;
  /** Re-read a lost session's records. Reading only; the session is untouched. */
  liveLookAgain(runId: string): Promise<LiveSnapshot>;
  /**
   * The run a workflow last had, as its ending left it, once the live store
   * has dropped it (ANT-275). For opening a finished session, never for
   * saying what is live: that is the snapshot's answer.
   */
  liveLastRun(workflowId: string): Promise<PendingRun | undefined>;

  /* The global agent library: reusable profiles that exist before any
     workflow. Descriptions of intended agents — nothing here executes. */
  agentsList(): Promise<GlobalAgentProfile[]>;
  agentsCreate(input: GlobalAgentInput): Promise<GlobalAgentProfile>;
  agentsUpdate(id: string, input: Partial<GlobalAgentInput>): Promise<GlobalAgentProfile | undefined>;
  agentsDuplicate(id: string): Promise<GlobalAgentProfile | undefined>;
  agentsRemove(id: string): Promise<boolean>;
  /**
   * The assistant's thread for one workflow, oldest turn first.
   *
   * Turns cross as they were written. Main remembers them; the panel owns what
   * a turn is and checks the shape on the way back in, so a record written by
   * an older Anthill costs the malformed turns and not the conversation.
   */
  assistantThreadRead(workflowId: string): Promise<unknown[]>;
  /** Record the thread as it now stands. The whole thread, not an append. */
  assistantThreadWrite(workflowId: string, turns: unknown[]): Promise<void>;
  /** Forget one workflow's thread. Only ever called from an explicit ask. */
  assistantThreadClear(workflowId: string): Promise<void>;
  /** The preferences this machine keeps, defaults filled in. */
  settingsRead(): Promise<AppSettings>;
  /** Change some of them; the rest are left alone. Returns what they now are. */
  settingsWrite(patch: Partial<AppSettings>): Promise<AppSettings>;
  /**
   * A browser page's error, already sanitized, for the CLI to report. Only the
   * CLI shell answers it; the desktop renderer reports through Sentry's IPC.
   */
  reportRendererError?(event: unknown): Promise<void>;
  /** The author's model preferences: hidden models, starting answers, tiers. */
  modelPreferencesRead(): Promise<ModelPreferences>;
  /** Replaces them, normalised. Rejects when the disk refused the write. */
  modelPreferencesWrite(next: ModelPreferences): Promise<ModelPreferences>;
  /** Whether Anthill's plugin is installed in Claude Code and Codex. Read-only. */
  pluginStatus(): Promise<PluginStatus>;
  /** Each tool's plugin, with its CLI and a live check of the server it launches. */
  pluginConnections(): Promise<PluginConnection[]>;
  /**
   * Install (or switch back on) Anthill's plugin in one tool, by running that
   * tool's own plugin commands. The tool may still ask for confirmation.
   */
  pluginInstall(harness: CheckedPluginHarness): Promise<PluginInstallResult>;
  /** Open the tool's own install guide in the browser: one fixed page per tool. */
  pluginGuide(harness: CheckedPluginHarness): Promise<void>;
  /** Open one of Anthill's own pages (`shared/links.ts`) in the default browser. */
  openLink?(name: ExternalLink): Promise<void>;
  /**
   * Send one notification now, so the author can see for themselves whether
   * they arrive.
   *
   * There is no API that answers whether macOS has been told to allow these:
   * the permission is granted or refused outside the app, and can be revoked
   * later without telling it. So the honest check is to send one and look.
   */
  notificationsProbe(): Promise<NotificationProbe>;
  /**
   * Everything Anthill observed for one run, oldest first.
   *
   * The renderer folds these into the page, because the fold needs the open
   * workflow and the workflow lives there. Main serves the log; it does not interpret it.
   */
  liveEvents(runId: string): Promise<ObservationEvent[]>;
  /** Subscribe to one run's activity growing. Returns an unsubscribe function. */
  onLiveEvents(
    listener: (payload: { runId: string; events: ObservationEvent[] }) => void,
  ): () => void;
  /** Subscribe to observation changes. Returns an unsubscribe function. */
  onLiveSnapshot(listener: (snapshot: LiveSnapshot) => void): () => void;
  /** Fires when the user picks Settings… (⌘,) from the menu bar. */
  onOpenSettings(listener: () => void): () => void;

  /* Local observation setup */

  /** Read local setup state. This does not write hook configuration. */
  liveSetupStatus(cwd?: string, refreshOnly?: boolean): Promise<ObservationSetupStatus>;
  /** Do not show the first-diagram setup prompt again unless reopened manually. */
  liveSetupDecline(harness: MarkerCli): Promise<void>;
  liveSetupDismiss(): Promise<ObservationSetupStatus>;
  /** Enable Anthill's passive observation hook entries for one available CLI. */
  liveSetupInstall(harness: MarkerCli, cwd?: string): Promise<ObservationSetupActionResult>;
  /** Remove only Anthill's passive observation hook entries for one CLI. */
  liveSetupDisable(harness: MarkerCli): Promise<ObservationSetupActionResult>;
}
