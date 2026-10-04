import { installedObservationRuntime } from "./live/installed-runtime.js";
/**
 * Anthill desktop shell — Electron main process.
 *
 * Owns the window and every privileged capability: filesystem dialogs, git
 * inspection, the run store, and spawning agent CLIs. The renderer runs with
 * `nodeIntegration: false` / `contextIsolation: true` and can only reach these
 * through the channels declared in `../shared/ipc.ts`.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell } from "electron";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

import { parseWorkflow } from "@anthill/workflow-schema";
import { checkWorkflowCompatibility, isCheckedPluginHarness, migrateWorkflow, PLUGIN_HARNESS_INFO } from "@anthill/workflow";
import { ExchangeStore } from "@anthill/exchange-store";
import { MARKER_VERSION, workflowSteps, type PendingRun } from "@anthill/live";
import type { Workflow } from "@anthill/workflow-schema";

import type { GlobalAgentInput } from "../shared/ipc.js";
import {
  IPC_CONTRACT,
  IpcChannel,
  LIVE_EVENTS_CHANNEL,
  LIVE_SNAPSHOT_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  OPEN_WORKFLOW_CHANNEL,
  SAVE_WORKFLOW_CHANNEL,
  REVEAL_WORKFLOW_CHANNEL,
  EDIT_HISTORY_CHANNEL,
  PROMPT_DRAFT_STAGE_CHANNEL,
  type AppSettings,
  type IpcCapabilities,
  type LiveObserveRequest,
  type ExportWorkflowRequest,
  type ExportWorkflowResponse,
  type InterpreterInfo,
  type MarkerCli,
  type ObservationSetupActionResult,
  type ObservationSetupStatus,
  type DraftFolder,
  type PromptDraftRequest,
  type PromptDraftResponse,
  type OpenWorkflowResult,
  type SaveWorkflowRequest,
  type SaveWorkflowResult,
} from "../shared/ipc.js";
import { createServices, type RunServices } from "./services.js";
import { destinationInside, FileGrants, FolderGrants, rootToWrite, writeAllOrNothing } from "./safe-write.js";
import {
  detectInterpreters,
  grantedDraftFolder,
  runDraft,
  shortenHome,
  signInToInterpreter,
} from "./interpreters.js";
import { readCodexModels } from "./codex-models.js";
import { readPiModels } from "./pi-models.js";
import { readCodexAgentSupport } from "./codex-capability.js";
import { adoptUserPath } from "./user-path.js";
import { isRealLoadFailure, loadFailureUrl } from "./load-failure.js";
import { WorkflowSaver, type ExternalSaveChoice } from "./workflow-save.js";
import { dataDirectoryRefusal, desktopUserDataPath, desktopDataDirectory } from "./user-data.js";
import {
  ExchangeInbox,
  SerialDrain,
  WindowOperations,
  WorkflowDelivery,
  boundWorkflow,
  linksFromArgv,
  readExchangeView,
  exchangeDestination,
  workflowIdFromLink,
  writeWorkingCopy,
  type OpenOutcome,
  type OpenPermission,
} from "@anthill/exchange-host";
import { REPORT_LOG } from "./live/observers/cli-report.js";
import { LiveSessionService, type LiveSessionSnapshot } from "./live/service.js";
import type { NoticeKind } from "./live/step-notices.js";
import { ObservationSetupService } from "./live/setup.js";
import { AgentLibraryStore } from "./agent-library.js";
import { AssistantThreadStore } from "./assistant-threads.js";
import { ModelPreferencesStore } from "./model-preferences.js";
import { pluginStatus } from "./plugin-status.js";
import { devCheckout, installPlugin, pluginConnections } from "./plugin-connect.js";
import { SettingsStore, reportingConsentOnDisk, workflowFolderPath } from "./settings.js";
import { DesktopAnalytics } from "./analytics.js";
import { SENTRY_DSN, sanitizeErrorEvent } from "../shared/error-reporting.js";
import { externalLink } from "../shared/links.js";
import { writeSettingsWithConsent, type ReportingGate } from "./diagnostics-consent.js";
import * as Sentry from "@sentry/electron/main";
import { claimScheme } from "./url-scheme.js";
import { PendingRunStore } from "./live/store.js";
import { WorkflowStatusStore } from "./live/workflow-status.js";
import { lastRun } from "./live/last-run.js";
import {
  forgetRecent,
  listRecents,
  rememberRecent,
  setRecentsPaths,
} from "./recents.js";

// Startup failures in the main process are otherwise invisible — the app just
// sits there with no window and no message. Surface them loudly.
//
// Installed above everything, including the choice of data directory below,
// because that choice is itself the earliest thing that can refuse to happen:
// a `--data-dir` this build will not accept, or one the filesystem will not
// create, threw out of module evaluation with these handlers six lines beneath
// it and no window anywhere, and the app died without printing a word.
const reporting: ReportingGate = { errors: false, nativeCrashes: false };
process.on("uncaughtException", (error) => {
  console.error("[anthill] uncaught exception:", error);
  if (reporting.errors) Sentry.captureException(error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[anthill] unhandled rejection:", reason);
  if (reporting.errors) Sentry.captureException(reason instanceof Error ? reason : new Error("Unhandled rejection"));
});

/**
 * The name the operating system shows: the dock, the menu bar, the About item.
 *
 * Without this Electron falls back to its own name. It fixes the About panel
 * and everything that asks the app what it is called; the name beside the
 * Apple menu and the Dock's tooltip come from the running bundle instead, so
 * in a dev run those keep saying Electron and only packaging changes them.
 *
 * Where the data lives is decided here and nowhere else. `userData` is
 * otherwise derived from whatever the app is currently called, so a rename —
 * `setName`, a `productName` in package.json, a packaged bundle — moves every
 * path underneath it: the recent list, the live-session records, the
 * observation journals, the run store. The app then comes up looking like a
 * fresh install to somebody with months of work in the old directory.
 *
 * So the location is written out literally rather than read back from the
 * app. Reading it first and pinning what came back was the earlier form of
 * this, and it only worked while nothing renamed the app *before* this file
 * ran: a packaged build does exactly that, and the read would have captured
 * the new, empty directory and pinned the app to it (ANT-13).
 *
 * Packaged builds retain that existing location without a migration. Dev
 * builds use desktop-dev so QA cannot share stores or the instance lock with
 * the installed app. Select this before taking the lock or creating stores.
 */
const USER_DATA_DIR = chooseDataDirectory();
app.setName("Anthill");
app.setPath("userData", USER_DATA_DIR);

/** Only the released macOS app reports anything; see `__ANTHILL_DIAGNOSTICS__`. */
const diagnosticsAvailable = __ANTHILL_DIAGNOSTICS__ && app.isPackaged && process.platform === "darwin";
const analytics = new DesktopAnalytics(USER_DATA_DIR, diagnosticsAvailable);
const launchConsent = reportingConsentOnDisk(join(USER_DATA_DIR, "settings.json"));
let reportErrorsAtLaunch = false;
if (diagnosticsAvailable && launchConsent.errorReportingEnabled) {
  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      ipcMode: Sentry.IPCMode.Classic,
      defaultIntegrations: launchConsent.nativeCrashReportingEnabled
        ? [Sentry.sentryMinidumpIntegration()]
        : [],
      sendDefaultPii: false,
      sendClientReports: false,
      tracesSampleRate: 0,
      attachScreenshot: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      beforeSend: (event) => reporting.errors && (event.platform !== "native" || reporting.nativeCrashes)
        ? sanitizeErrorEvent(event)
        : null,
    });
    reporting.errors = true;
    reporting.nativeCrashes = launchConsent.nativeCrashReportingEnabled;
    reportErrorsAtLaunch = true;
  } catch (error) {
    console.error("[anthill] error reporting could not start:", error);
  }
}

/**
 * The data directory, or a box saying why there is not going to be one.
 *
 * `dialog.showErrorBox` is the one dialog Electron allows before `ready`,
 * which is exactly where this is — long before a window exists and before any
 * store has been opened. Nothing else in the app could carry this message: a
 * refusal here means there is nowhere to write, so there will be no window and
 * no page to put a notice in.
 */
function chooseDataDirectory(): string {
  const fallback = desktopUserDataPath(app.getPath("appData"), app.isPackaged);
  try {
    const directory = desktopDataDirectory(process.argv, fallback);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  } catch (error) {
    dialog.showErrorBox("Anthill cannot start", dataDirectoryRefusal(error, fallback));
    app.exit(1);
    // `app.exit` ends the process, which the type checker has no way to know.
    throw error;
  }
}

let mainWindow: BrowserWindow | null = null;
let services: RunServices | null = null;
let historyLoading: Promise<RunServices> | undefined;
function history(): Promise<RunServices> {
  historyLoading ??= createServices(join(app.getPath("userData"), "runs"), electronSqliteBinding())
    .then((opened) => (services = opened))
    .catch((error) => { historyLoading = undefined; throw error; });
  return historyLoading;
}
/**
 * The legacy history, when there is one to read.
 *
 * A store that will not open is the same fact, from the page's side, as a
 * store that is not there: there is no snapshot for this run either way. It
 * did not used to be — `history()` rethrows, the rejection crossed to the
 * renderer, and `LiveSessionPage` awaits `getRun` *before* falling back to the
 * open workflow, so a machine with an old `runs.db` and a native binding
 * Electron could not load answered every manually pasted session with an error
 * box and a Retry that re-ran the same failing open. Editing and passive
 * observation do not depend on this database; saying so is this function.
 *
 * The failure is still reported once, and `history()` clears its own cache on
 * the way out, so a store that becomes readable later is opened later.
 */
async function historyIfReadable(): Promise<RunServices | undefined> {
  if (!existsSync(join(app.getPath("userData"), "runs", "runs.db"))) return undefined;
  return history().catch((error) => {
    console.error("Anthill could not open its legacy run history:", error);
    return undefined;
  });
}
/** Folders a dialog handed out in this session; see `safe-write.ts`. */
const grants = new FolderGrants();
/**
 * Folders the author let a drafting CLI read (ANT-67). Kept apart from
 * `grants`: agreeing that a CLI may read a folder is not agreeing that Anthill
 * may write agent files into it.
 */
const draftFolders = new FolderGrants();
const workflowFiles = new FileGrants();

/**
 * Whether the page has asked for its pending workflow yet.
 *
 * Until then requests stay in their source queue (inbox or pendingLinks),
 * rather than competing for a single pending path that could overwrite one.
 */
let rendererListening = false;
const windowOperations = new WindowOperations();
const workflowDelivery = new WorkflowDelivery();
const pendingLinks = new Set<string>();
let closePending = false;

/**
 * Whether the open workflow has unsaved edits, as last reported over IPC.
 *
 * This is only a fallback. IPC delivery is asynchronous, so an edit followed
 * immediately by a window close could be decided on a stale value — the exact
 * case the guard exists to prevent. `isWorkflowDirty` therefore asks the renderer
 * at close time and uses this only if that fails.
 */
let workflowDirty = false;

/** Global the renderer sets synchronously on every edit. */
const DIRTY_FLAG = "window.__anthillWorkflowDirty === true";

/**
 * Read the live dirty state from the renderer.
 *
 * Falls back to the last value pushed over IPC if the page cannot be queried
 * (already destroyed, or script evaluation refused) — better to ask once too
 * often than to discard work silently.
 */
async function isWorkflowDirty(window: BrowserWindow): Promise<boolean> {
  try {
    return Boolean(await window.webContents.executeJavaScript(DIRTY_FLAG, true));
  } catch {
    return workflowDirty;
  }
}
/** Set once the user has confirmed discarding, so the retried close goes through. */
let allowCloseWithUnsavedWorkflow = false;

/**
 * Whether the app is on its way out, rather than one window closing.
 *
 * The window's `close` handler always cancels the first close and decides
 * asynchronously, and a cancelled close aborts a quit. It then closed only
 * the window — and on macOS an app with no windows keeps running. So Cmd+Q
 * left a windowless process behind, and a SIGTERM did nothing at all: the
 * dev watcher's restart never replaced the running app, and the replacement,
 * finding the lock still held, quit in a third of a second and took the dev
 * server with it (ANT-72). Knowing the quit was asked for is what lets the
 * close handler carry it on once the question is settled.
 */
let quitting = false;

/**
 * Ask before something throws the open workflow's unsaved edits away.
 *
 * Three things in this process can: closing the window, restarting, and opening
 * another workflow over the top of this one. They ask the same question in the
 * same words, and each says in its own what is about to be lost — a restart
 * offered as a fix that silently discarded somebody's work would be a worse
 * fault than whatever they were restarting to cure.
 *
 * `true` means go ahead, including when there was nothing to lose.
 */
async function mayDiscardWorkflow(
  window: BrowserWindow,
  button: string,
  detail: string,
): Promise<boolean> {
  if (!(await isWorkflowDirty(window))) return true;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Cancel", button],
    defaultId: 0,
    cancelId: 0,
    message: "This workflow has unsaved changes.",
    detail,
  });
  return response === 1;
}

/**
 * Locate the Electron-ABI build of better-sqlite3.
 *
 * The npm-installed copy is compiled for the system Node and fails to load
 * under Electron, so `scripts/fetch-electron-sqlite.mjs` keeps a separate
 * Electron build next to the app.
 *
 * In a packaged build it lands under `app.asar.unpacked/`, because the
 * `asarUnpack` glob for native addons takes them out of the archive but leaves
 * each file where it sat inside it. This used to look in `Resources/native/`
 * instead — where a file would be only if it were an `extraResource` — found
 * nothing, and returned `undefined`; better-sqlite3 then fell back to its own
 * resolution and picked up the *Node*-ABI copy that ships alongside as an
 * ordinary dependency. The app died at startup on a NODE_MODULE_VERSION
 * mismatch: the exact failure this function exists to prevent, in the one
 * build nobody runs while developing.
 *
 * Both paths are tried, so an `extraResources` layout would work too, and
 * `packaging.test.ts` holds the two in agreement.
 *
 * Returns `undefined` when there is genuinely nothing, so the fallback error
 * names the real problem rather than this function hiding it.
 */
function electronSqliteBinding(): string | undefined {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, "app.asar.unpacked/native/better_sqlite3.node"),
        join(process.resourcesPath, "native/better_sqlite3.node"),
      ]
    : [
        join(__dirname, "../../native/better_sqlite3.node"),
        join(app.getAppPath(), "apps/desktop/native/better_sqlite3.node"),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Learning the author's real PATH, started at once and awaited where it counts.
 *
 * A double-clicked app is started by launchd rather than by a shell, so it
 * inherits a bare system PATH with none of the places a coding CLI lives —
 * `~/.local/bin`, Homebrew, any version manager. Every "Claude Code was not
 * found" that produces is false, and it cannot appear in development, where
 * Electron is started from a shell that already has the right PATH.
 *
 * Kicked off here rather than awaited before the window: asking a login shell
 * costs however long somebody's rc file takes, and a window that waits on that
 * is a window that looks broken. Nothing before the first "what is installed?"
 * needs it, and that question waits on this promise instead.
 *
 * It cannot fail in a way that matters — no shell, a slow one, or a strange
 * answer all leave the PATH exactly as it was.
 */
const userPath = adoptUserPath().catch(() => false);

/**
 * Passive observation of sessions the user starts themselves.
 *
 * Created on first use and kept out of `services`: nothing about observing for a
 * session should be able to stop the Workflow from starting. It holds no process
 * and can start none — it reads the records the user's own CLIs write.
 */
let live: LiveSessionService | undefined;
let liveSetup: ObservationSetupService | undefined;
let exchangeStore: ExchangeStore | undefined;
let inbox: ExchangeInbox | undefined;
let agents: AgentLibraryStore | undefined;
let assistantThreads: AssistantThreadStore | undefined;
let settingsStore: SettingsStore | undefined;
let workflowStatusStore: WorkflowStatusStore | undefined;

/**
 * `~` is a shell convenience, not a path. Agents write it constantly, and
 * `existsSync("~/x")` is false for every one of them.
 */
function expandHome(path: string): string {
  if (path === "~") return app.getPath("home");
  return path.startsWith("~/") ? join(app.getPath("home"), path.slice(2)) : path;
}

function workflowStatus(): WorkflowStatusStore {
  workflowStatusStore ??= new WorkflowStatusStore(
    join(app.getPath("userData"), "workflow-status.json"),
  );
  return workflowStatusStore;
}

function settings(): SettingsStore {
  settingsStore ??= new SettingsStore(join(app.getPath("userData"), "settings.json"));
  return settingsStore;
}

let modelPreferencesStore: ModelPreferencesStore | undefined;

function modelPreferences(): ModelPreferencesStore {
  modelPreferencesStore ??= new ModelPreferencesStore(join(app.getPath("userData"), "model-preferences.json"));
  return modelPreferencesStore;
}

/**
 * Show one native notification.
 *
 * The whole platform half of the feature, in one place. macOS decides whether
 * it appears: there is no API that reports the permission, and it can be
 * revoked later without the app being told, so nothing here pretends to know
 * more than "this was handed over". A system that cannot show one at all says
 * so, which is the one case Settings can state as fact.
 */
/**
 * Which preference each kind of notice answers to.
 *
 * A finish and a failure share one switch: both are "the session stopped",
 * and somebody who wants to hear the one wants to hear the other.
 */
const NOTICE_SETTING: Record<NoticeKind, keyof AppSettings> = {
  "step-started": "stepNotifications",
  "step-finished": "stepFinishedNotifications",
  loop: "loopNotifications",
  "needs-you": "needsYouNotifications",
  finished: "finishedNotifications",
  failed: "finishedNotifications",
  "observation-lost": "observationLostNotifications",
};

/**
 * One line per notification outcome, in the data directory.
 *
 * A notification that goes nowhere leaves no trace anywhere else: the OS
 * does not say, and the person was, by definition, not looking (ANT-132).
 */
function noteNotification(line: string): void {
  try {
    appendFileSync(join(app.getPath("userData"), "notifications.log"), `${line}\n`);
  } catch {
    // A diagnostic that cannot be written is not worth failing anything over.
  }
}

function showNotification(
  title: string,
  body: string,
): Promise<{ kind: "sent" } | { kind: "unsupported"; reason: string }> {
  if (!Notification.isSupported()) {
    return Promise.resolve({
      kind: "unsupported",
      reason: "This system has no notification centre Anthill can use.",
    });
  }
  return new Promise((resolve) => {
    try {
      // Silent: a step changing is worth a glance, not a sound. The workflow's
      // name is the title, so a notification is attributable at a glance to the
      // thing it is about rather than to "Anthill" in general.
      const notification = new Notification({ title, body, silent: true });
      /*
        macOS answers on the notification itself, not on `show()`. Since
        Electron 42 the User Notifications framework says when it refused one
        — an unsigned build, a revoked permission — where the API before it
        said nothing at all, and Anthill's step notifications went nowhere for
        the whole of macOS 26 without a word (ANT-132). A refusal is reported
        as the reason it gave; a `show` is "sent", which is still all Anthill
        can know about whether it appeared.
      */
      let settled = false;
      const settle = (outcome: string, result: { kind: "sent" } | { kind: "unsupported"; reason: string }) => {
        if (settled) return;
        settled = true;
        noteNotification(`${new Date().toISOString()} ${outcome} – ${title}: ${body}`);
        resolve(result);
      };
      notification.once("show", () => settle("shown", { kind: "sent" }));
      notification.once("failed", (_event, error) =>
        settle(`failed: ${error}`, { kind: "unsupported", reason: `macOS refused it: ${error}` }),
      );
      notification.show();
      // Neither event is guaranteed on every platform; a probe must not hang.
      setTimeout(() => settle("no answer within 2s", { kind: "sent" }), 2_000);
    } catch (error) {
      resolve({
        kind: "unsupported",
        reason: error instanceof Error ? error.message : "The notification could not be sent.",
      });
    }
  });
}

function assistantThreadStore(): AssistantThreadStore {
  assistantThreads ??= new AssistantThreadStore(
    join(app.getPath("userData"), "assistant-threads.json"),
  );
  return assistantThreads;
}

function agentLibrary(): AgentLibraryStore {
  agents ??= new AgentLibraryStore(join(app.getPath("userData"), "global-agents.json"));
  return agents;
}

/**
 * Where workflows handed over by a coding harness are kept.
 *
 * The MCP server writes into the same tree from a separate process, which is
 * why nothing in it is ever rewritten and why this side needs no lock to read
 * it. The directory is asked for at call time like every other store's, because
 * `userData` is pinned during module evaluation and re-deriving it anywhere
 * else is how a rename once moved every store out from under the app (ANT-13).
 */
function exchange(): ExchangeStore {
  exchangeStore ??= new ExchangeStore(app.getPath("userData"));
  return exchangeStore;
}

function liveService(): LiveSessionService {
  live ??= new LiveSessionService(
    new PendingRunStore(join(app.getPath("userData"), "live-sessions.json")),
    (snapshot: LiveSessionSnapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(LIVE_SNAPSHOT_CHANNEL, snapshot);
      }
    },
    () => new Date().toISOString(),
    { journalDir: join(app.getPath("userData"), "live-observations"), reportLogPath: REPORT_LOG },
    (runId, events) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(LIVE_EVENTS_CHANNEL, { runId, events });
      }
    },
    // The preference is read here rather than inside the service, and read at
    // the moment of the transition rather than cached: turning the setting off
    // has to stop the next notification, including one whose step was already
    // being observed when the switch was flipped.
    (notice) => {
      void settings()
        .read()
        .then((current) => {
          if (!current[NOTICE_SETTING[notice.kind]]) return;
          return showNotification(notice.title, notice.body).then((result) => {
            // Written down, so a notification that goes nowhere leaves a
            // trace somewhere other than the author's memory (ANT-132).
            if (result.kind !== "sent") console.warn(`[anthill] step notification not delivered: ${result.reason}`);
          });
        })
        .catch(() => undefined);
    },
    // How a run ended outlives the run itself, so the launch window can still
    // colour its row a week later (ANT-84).
    (run) => void workflowStatus().remember(run).catch(() => undefined),
  );
  return live;
}

/**
 * The run a workflow last had, from the ending it left (ANT-275).
 *
 * For the Live session tab once the live store has dropped a settled run. A
 * run still in that store is the snapshot's to report, and the renderer asks
 * here only when the snapshot has nothing for the workflow.
 */
async function lastRunOf(workflowId: string): Promise<PendingRun | undefined> {
  const status = (await workflowStatus().all())[workflowId];
  return lastRun(workflowId, status, {
    events: (runId) => liveService().events(runId),
    binding: (id, runId) => exchange().readBinding(id, runId),
  });
}

/** The same, found by the run's id. */
async function keptRun(runId: string): Promise<PendingRun | undefined> {
  const found = await workflowStatus().find(runId);
  return found ? lastRunOf(found.workflowId) : undefined;
}

function liveSetupService(): ObservationSetupService {
  liveSetup ??= new ObservationSetupService({
    legacyPrefsPaths: [join(app.getPath("userData"), "live-observation-setup.json")],
    ...(app.isPackaged
      ? { execPath: process.execPath, hookHandlerPath: join(__dirname, "live-hook-handler.js") }
      : installedObservationRuntime() ?? {
          hookHandlerPath: join(__dirname, "live-hook-handler.js"),
          installProblem: "Install the packaged Anthill app before connecting permanent hooks. Basic progress remains available in development builds.",
        }),
  });
  return liveSetup;
}

/**
 * Where the application icon is, whether this is a dev run or a packaged one.
 *
 * Unpackaged, the app runs out of `node_modules/electron`, so without this the
 * dock shows Electron's own icon and the window is indistinguishable from any
 * other Electron shell on the machine.
 */
function iconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "icon.png")]
    : [join(__dirname, "../../build/icon.png"), join(app.getAppPath(), "apps/desktop/build/icon.png")];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Put Anthill's own mark on the dock.
 *
 * macOS takes a packaged app's icon from its bundle, which does not exist in a
 * dev run — `app.dock.setIcon` is the only way to change it while the app is
 * the Electron shell. Harmless when packaging arrives: the bundle icon wins and
 * this sets the same image over the top of it.
 */
function applyAppIcon(): void {
  const path = iconPath();
  if (!path) return;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return;
  // macOS only; elsewhere the icon rides on the window itself.
  app.dock?.setIcon(image);
}

function createWindow(): void {
  allowCloseWithUnsavedWorkflow = false;
  workflowDirty = false;
  closePending = false;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "Anthill",
    backgroundColor: "#f6f7f9",
    // Windows and Linux take the icon from the window; macOS from the dock.
    ...(process.platform === "darwin" ? {} : { icon: iconPath() }),
    webPreferences: {
      additionalArguments: reportErrorsAtLaunch ? ["--anthill-report-errors"] : [],
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  /*
    A window that cannot load says so.

    Both calls used to be discarded with `void`, so a failed load produced an
    empty window and nothing else — no page, no message, nothing in the app to
    read. It reads as "Anthill is broken" when the usual cause in development
    is that `electron-vite`'s dev server has stopped answering and the window
    was restarted against it.

    `did-fail-load` rather than the promise alone, because it also catches a
    reload that fails later — pressing ⌘R against a server that is still down
    has to say the same thing rather than blanking the window again. The guard
    stops the error page's own load from being treated as another failure.
  */
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  let showingFailure = false;
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (showingFailure || !isRealLoadFailure(errorCode, isMainFrame)) return;
      showingFailure = true;
      void mainWindow
        ?.loadURL(
          loadFailureUrl({
            url: validatedURL || rendererUrl || "the app's own files",
            error: errorDescription || `error ${errorCode}`,
            dev: Boolean(rendererUrl),
          }),
        )
        .finally(() => {
          showingFailure = false;
        });
    },
  );

  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Ask before throwing away an unsaved workflow. `close` is cancellable; `closed`
  // is too late.
  // Always cancel the first close and decide asynchronously, because the only
  // trustworthy dirty state lives in the renderer and reading it is async.
  mainWindow.on("close", (event) => {
    if (allowCloseWithUnsavedWorkflow) return;

    const window = mainWindow;
    if (!window) return;

    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void windowOperations.run(async () => {
      if (window.isDestroyed()) return;
      const mayClose = await mayDiscardWorkflow(
        window,
        "Discard changes",
        "Closing now discards everything since the last save.",
      );
      if (!mayClose) {
        // The person kept their work, so the quit that asked is off too.
        quitting = false;
        return;
      }

      allowCloseWithUnsavedWorkflow = true;
      workflowDirty = false;
      // Carry on with what was asked: a quit, not just this window.
      if (quitting) app.quit();
      else window.close();
    }).finally(() => {
      closePending = false;
      // A link queued behind a cancelled close still needs delivery.
      void drainLinks();
    });
  });

  // Every load starts a page that has not asked for its pending workflow yet,
  // so anything handed over before it does has to wait in main rather than be
  // sent to nobody. A reload counts: the page that was listening is gone.
  mainWindow.webContents.on("did-start-loading", () => {
    rendererListening = false;
    workflowDelivery.reset();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererListening = false;
    workflowDelivery.reset();
  });
}

/**
 * Open one workflow file, whoever asked for it.
 *
 * At module scope rather than inside `registerIpcHandlers`, because IPC is no
 * longer the only way a workflow gets opened: a harness can hand one over
 * through the exchange inbox, and an `anthill://` link can name one. All three
 * go through here, so a handed-over workflow is migrated, compatibility-checked
 * and reported on in exactly the words the Open command uses.
 *
 * It remembers the file in the recent list even when nobody clicked anything,
 * and that is deliberate. The recent list is how a person finds a workflow
 * again after closing it, and a workflow that arrived while they were looking
 * elsewhere is the one they are most likely to go hunting for. Nothing depends
 * on it — a link resolves through the store, which knows every handover rather
 * than the last twelve files — so this is a convenience, not a route.
 */
/**
 * The first save of a workflow opened from outside the workflow folder: write
 * back into that file, or put a copy in the folder and keep saving there.
 */
async function askAboutExternalSave(path: string): Promise<ExternalSaveChoice> {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    message: `Save over “${basename(path)}”?`,
    detail: `This workflow was opened from ${dirname(path)}, outside your workflow folder. Overwrite that file, or save a new copy in the workflow folder from Settings.`,
    buttons: ["Overwrite", "Save Copy in Folder", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  };
  const { response } = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return response === 0 ? "overwrite" : response === 1 ? "copy" : "cancel";
}

async function openWorkflowAt(path: string): Promise<OpenWorkflowResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));

    // Compatibility is checked before schema parsing on purpose. A workflow from
    // a newer build may not satisfy this build's schema at all, and
    // "Invalid workflow: nodes.0.type ..." would hide the real reason.
    const original = checkWorkflowCompatibility(parsed);
    if (!original.ok && original.reason === "too-new") {
      return { ok: false, error: original.message };
    }

    // Upgrade what this build knows how to upgrade, so an older workflow opens
    // as a current one rather than opening with a warning the author has to
    // work through by hand. The file on disk is untouched until they save.
    const migration = migrateWorkflow(parsed);

    // Compatibility is re-checked on the upgraded workflow: a workflow the migration
    // brought current is current, and telling the author to go and fix it by
    // hand as well would contradict the note saying it was upgraded.
    const compatibility = checkWorkflowCompatibility(migration.workflow);
    const notice = [
      ...migration.notes,
      ...(compatibility.ok ? [] : [compatibility.message]),
    ];

    const workflow = parseWorkflow(migration.workflow);
    await workflowFiles.grant(path);
    await rememberRecent(path);
    analytics.capture("workflow_opened");
    return {
      ok: true,
      opened: {
        path,
        workflow,
        notice: notice.length > 0 ? notice.join(" ") : undefined,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Workflows handed over from outside                                 */
/* ------------------------------------------------------------------ */

/**
 * The window a handed-over workflow goes to, opening one if there is none.
 *
 * macOS keeps the app running after the last window closes, and a workflow
 * handed over then has nowhere to appear. Opening a window is the one thing in
 * this whole feature that Anthill does rather than observes, and it is what the
 * person asked their coding tool for — every other arrow points inward.
 *
 * `opened` says the window is new, which is how the caller knows there is
 * nothing in it to ask about.
 */
function workflowWindow(): { window: BrowserWindow; opened: boolean } | undefined {
  if (mainWindow && !mainWindow.isDestroyed()) return { window: mainWindow, opened: false };
  // Before `whenReady` a BrowserWindow cannot be constructed at all, and the
  // caller's answer is "not yet" rather than "never".
  if (!app.isReady()) return undefined;
  createWindow();
  return mainWindow ? { window: mainWindow, opened: true } : undefined;
}

/** Whether a workflow nobody asked for may take the screen. */
async function mayShowWorkflow(): Promise<OpenPermission> {
  const target = workflowWindow();
  if (!target) return "no_window";
  if (!rendererListening || closePending) return "no_window";
  // The renderer asks at navigation commit, after all asynchronous preparation.
  // Consent here could refer to a document that is no longer on screen then.
  return "yes";
}

/**
 * Hand a request to the current page. If it went away during preparation,
 * leave the request in its source queue for the next ready page.
 */
function handOverToRenderer(path: string, deliveryId: number): boolean {
  if (rendererListening && !closePending && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(OPEN_WORKFLOW_CHANNEL, path, deliveryId);
    return true;
  }
  return false;
}

/** Open a workflow the user did not pick, and put it on screen. */
async function showWorkflow(path: string): Promise<OpenOutcome> {
  const result = await openWorkflowAt(path);
  if (!result.ok) {
    return { kind: "refused", error: "error" in result ? result.error : "It could not be opened." };
  }
  const delivery = await workflowDelivery.deliver(path, (id) => handOverToRenderer(path, id));
  if (delivery === "declined") return { kind: "declined" };
  if (delivery === "shown") {
    mainWindow?.show();
    mainWindow?.focus();
    return { kind: "shown" };
  }
  return delivery === "parked"
    ? { kind: "parked" }
    : { kind: "unconfirmed", error: "The page did not confirm opening the workflow. The handover remains pending; reopen it from its link." };
}

function receiveLink(url: string): void {
  if (!workflowIdFromLink(url)) {
    void refuseHandover("This is not a supported anthill://workflow/<id> link. Nothing was opened.");
    return;
  }
  pendingLinks.add(url);
  if (app.isReady()) {
    workflowWindow();
    void drainLinks();
  }
}

const linkDrain = new SerialDrain(() => drainOnce());

/**
 * Deliver every link that is waiting, one at a time and once each.
 *
 * Three things call this — a link arriving, a close the user cancelled, and
 * the page asking for its pending workflow — and a pass stops in the middle
 * for a dialog, so two of them used to walk the same set at once.
 */
function drainLinks(): Promise<void> {
  return linkDrain.run();
}

async function drainOnce(): Promise<void> {
  if (!rendererListening) return;
  for (const url of [...pendingLinks]) {
    pendingLinks.delete(url);
    // Coordinate window availability and preparation with closing, but never
    // hold the close queue while the renderer asks for consent or opens a file.
    const prepared = await windowOperations
      .run(async (): Promise<string | undefined> => {
        const id = workflowIdFromLink(url)!;
        const stored = await exchange().readWorkflow(id);
        if (!stored?.head || stored.problems.length) {
          await refuseHandover(`Workflow ${id} is missing or unreadable in this Anthill data directory.`);
          return undefined;
        }
        const path = exchange().workingCopyPath(id);
        const permission = await mayShowWorkflow();
        if (permission === "no_window") { pendingLinks.add(url); return undefined; }
        if (permission === "declined") return undefined;
        await writeWorkingCopy(path, stored.head.workflow);
        return path;
      })
      .catch(async (error) => { await refuseHandover(String(error)); return undefined; });
    if (!prepared) continue;
    const result = await showWorkflow(prepared).catch((error): OpenOutcome => ({ kind: "refused", error: String(error) }));
    if (result.kind === "parked") pendingLinks.add(url);
    // A parked handover is on its way to the next page that asks for one, so
    // saying it failed would be untrue and the user would be shown it twice.
    // Anything else the person clicked a link for is worth a sentence.
    if (result.kind === "refused" || result.kind === "unconfirmed") await refuseHandover(result.error);
  }
}

/**
 * Say that something arrived which cannot be acted on.
 *
 * A native box rather than a notice in the page, because most of what reaches
 * here is a file on disk this build cannot read — the same class of thing the
 * run store's startup failure reports this way, and the one case where there
 * may be no page to put a notice in.
 */
async function refuseHandover(message: string): Promise<void> {
  dialog.showErrorBox("Anthill could not carry out a handover", message);
}

function exchangeInbox(): ExchangeInbox {
  inbox ??= new ExchangeInbox(exchange(), {
    serialize: (work) => windowOperations.run(work),
    mayOpen: mayShowWorkflow,
    open: showWorkflow,
    refuse: refuseHandover,
    register: async (run): Promise<boolean> => {
      try {
        const service = liveService();
        // A run already registered is not registered again. The stored record
        // carries everything the observers have learned since, and putting a
        // fresh one over the top would forget that the session was ever found
        // and start waiting for it a second time.
        return await service.registerBinding({
          boundAt: run.boundAt,
          exchange: { revision: run.revision.revision, digest: run.revision.digest, ...(run.sessionId ? { sessionId: run.sessionId } : {}) },
          anthillRunId: run.runId,
          correlationNonce: run.nonce,
          selectedCli: run.harness,
          promptVersion: MARKER_VERSION,
          // The revision's digest stands in for the prompt hash. Nothing reads
          // it for its provenance; it identifies the content a run started
          // from, which is exactly what a revision digest is.
          bootstrapPromptHash: run.revision.digest,
          workflowId: run.workflowId,
          ...(run.revision.workflow.name ? { workflowName: run.revision.workflow.name } : {}),
          steps: workflowSteps(run.revision.workflow),
        });
      } catch (error) {
        console.error("[anthill] could not register a bound run:", error);
        return false;
      }
    },
  });
  return inbox;
}

/**
 * Every channel this process actually registered, in the order it did.
 *
 * Recorded rather than derived from `IpcChannel`, because the question the
 * renderer needs answered is not "what does the contract name" — both sides
 * share that file — but "what does the process that is running right now
 * actually answer". A channel added to the contract and served by a main
 * process from before the edit must not appear here.
 */
const registered: string[] = [];

/** `ipcMain.handle`, plus a note that it happened. */
function handle(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  ipcMain.handle(channel, listener);
  registered.push(channel);
}

function registerIpcHandlers(): void {
  const workflowSaver = new WorkflowSaver({
    folder: async () => workflowFolderPath(await settings().read(), homedir()),
    files: workflowFiles,
    exchange,
    ask: askAboutExternalSave,
    linksPath: join(app.getPath("userData"), "workflow-save-links.json"),
  });
  // Legacy history is read-only. Removing the runner must not remove the
  // snapshot lookup used by the manual copy-paste Live Session page.
  handle(IpcChannel.runList, async () => (await historyIfReadable())?.store.listRuns() ?? []);
  handle(IpcChannel.runGet, async (_event, runId: string) =>
    (await historyIfReadable())?.store.getRun(runId));
  handle(
    IpcChannel.appCapabilities,
    async (): Promise<IpcCapabilities> => ({
      contract: IPC_CONTRACT,
      channels: [...registered],
      shell: "desktop",
      platform: process.platform,
      home: homedir(),
    }),
  );

  /*
   * Quit, from the Windows gate's Exit (ANT-154). `app.quit()` closes the
   * window the ordinary way, so its close handler still asks about unsaved
   * work — Exit on a first-run gate has none, but it must not be the one
   * door that skips the question.
   */
  handle(IpcChannel.appQuit, async (): Promise<boolean> => {
    setTimeout(() => app.quit(), 50);
    return true;
  });

  /**
   * Restart Anthill.
   *
   * `app.relaunch()` schedules a fresh instance and `app.exit()` ends this one
   * without running the window's `close` handler — so the unsaved-workflow question
   * has to be asked here instead, or a restart offered as a fix would quietly
   * throw away the user's work.
   */
  handle(IpcChannel.appRelaunch, async (): Promise<boolean> => {
    const window = mainWindow;
    if (window && !window.isDestroyed()) {
      const mayRestart = await mayDiscardWorkflow(
        window,
        "Restart and discard changes",
        "Restarting now discards everything since the last save.",
      );
      if (!mayRestart) return false;
    }
    app.relaunch();
    // Give the reply a chance to reach the renderer before the process ends.
    setTimeout(() => app.exit(0), 100);
    return true;
  });

  handle(
    IpcChannel.workflowOpen,
    async (_event, requested?: string): Promise<OpenWorkflowResult> => {
      if (requested && (await workflowFiles.has(requested) ||
          (await listRecents()).some((item) => item.path === requested))) {
        return withSavedJson(await openWorkflowAt(requested));
      }

      const result = await dialog.showOpenDialog({
        title: "Open workflow",
        ...(requested ? { defaultPath: requested } : {}),
        // Matching on the bare ".json" suffix, so a file saved by any earlier
        // build shows up here whatever double suffix it used — nothing about
        // opening needs to change when the write side emits a new one.
        filters: [{ name: "Workflow JSON", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, cancelled: true };
      }

      return withSavedJson(await openWorkflowAt(result.filePaths[0]));
    },
  );

  /**
   * A handover's JSON is in the workflow folder from the moment it opens, so
   * Reveal always has a file of the author's to show, never the exchange's
   * working copy. An exported JSON reopened later gets its handover back.
   */
  async function withSavedJson(result: OpenWorkflowResult): Promise<OpenWorkflowResult> {
    if (!result.ok) return result;
    const { path, workflow } = result.opened;
    try {
      if (await exchangeDestination(exchange(), path, workflow.id)) {
        const exported = await workflowSaver.exportHandover(path, workflow);
        return { ok: true, opened: { ...result.opened, path: exported, exchangePath: path } };
      }
      const linked = await workflowSaver.linkedExchangePath(path, workflow.id);
      return linked ? { ok: true, opened: { ...result.opened, exchangePath: linked } } : result;
    } catch (error) {
      // The workflow is still worth showing; Save will try the JSON again.
      const reason = `Its JSON could not be written to the workflow folder: ${error instanceof Error ? error.message : String(error)}`;
      const isHandover = await exchangeDestination(exchange(), path, workflow.id).catch(() => false);
      return {
        ok: true,
        opened: {
          ...result.opened,
          ...(isHandover ? { exchangePath: path } : {}),
          notice: [result.opened.notice, reason].filter(Boolean).join(" "),
        },
      };
    }
  }

  // Keep the readiness handshake, but deliver every request through the same
  // acknowledged channel, including requests that arrived before this page.
  handle(IpcChannel.workflowPendingOpen, async (): Promise<string | undefined> => {
    rendererListening = true;
    void drainLinks();
    return undefined;
  });
  handle(IpcChannel.workflowOpened, async (event, path: string, id?: number, outcome?: "shown" | "declined" | "confirming" | "opening") => {
    if (rendererListening && event.sender === mainWindow?.webContents) workflowDelivery.acknowledge(path, id, outcome);
  });
  handle(IpcChannel.exchangeRead, async (_event, path: string, id: string) =>
    readExchangeView(exchange(), await workflowSaver.linkedExchangePath(path, id) ?? path, id));
  handle(IpcChannel.liveWorkflow, async (_event, runId: string) => {
    await liveService().start();
    // A finished run the live store has dropped still names its revision
    // through the record it left (ANT-275).
    const run = liveService().registered(runId) ?? (await keptRun(runId));
    return boundWorkflow(exchange(), run);
  });
  handle(IpcChannel.liveLastRun, async (_event, workflowId: string) =>
    typeof workflowId === "string" ? lastRunOf(workflowId) : undefined);

  handle(
    IpcChannel.workflowSave,
    async (_event, request: SaveWorkflowRequest): Promise<SaveWorkflowResult> => {
      const result = await workflowSaver.save(request);
      if (result.kind !== "saved") return result;
      // A recent-list failure must not turn a durable JSON save into a failure.
      await rememberRecent(result.path).catch((error) => console.error("[anthill] remember saved workflow:", error));
      analytics.capture("workflow_saved");
      return result;
    },
  );

  // The launch window's list of what was open recently.
  /*
    The list, with each row's last known outcome attached.

    Joined here rather than inside `listRecents` because the two answer
    different questions from different places: that one is about files on disk,
    this one is about what Anthill observed. A row whose workflow is being
    watched right now is coloured from the live snapshot instead — the renderer
    prefers the live run, so these two can never contradict each other.
  */
  handle(IpcChannel.recentsList, async () => {
    const [rows, endings] = await Promise.all([listRecents(), workflowStatus().all()]);
    return rows.map((row) => {
      const ending = row.workflowId ? endings[row.workflowId] : undefined;
      return ending
        ? {
            ...row,
            lastRun: {
              state: ending.state,
              at: ending.at,
              ...(ending.stopped ? { stopped: true } : {}),
              ...(ending.unclaimed ? { unclaimed: true } : {}),
            },
          }
        : row;
    });
  });

  handle(IpcChannel.recentsForget, async (_event, path: string) => {
    // Taking a row off the list takes its dot with it: this record is only
    // ever read through that list, so one left behind could never be asked
    // about again.
    const row = (await listRecents()).find((item) => item.path === path);
    await forgetRecent(path);
    if (row?.workflowId) await workflowStatus().forget(row.workflowId);
  });

  /*
    Paths an agent wrote about, and showing one on disk.

    Two handlers rather than one, because they answer different questions and
    only the second does anything. The renderer asks which paths are real so it
    can offer only those as clickable, and gets back nothing but booleans — it
    never learns anything about a path it did not already have.

    Reveal, never open. `shell.openPath` on a path an external agent wrote
    would run whatever that path turns out to be — an app bundle, a script, an
    installer — which is exactly the capability the message renderer exists to
    withhold. `showItemInFolder` selects the item in Finder and executes
    nothing.
  */
  // Choose the destination for desktop Save. Export still has its own grants.
  handle(IpcChannel.workflowFolderChoose, async () => {
    const current = workflowFolderPath(await settings().read(), homedir());
    const result = await dialog.showOpenDialog({
      title: "Choose where workflows are saved",
      defaultPath: current,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return settings().write({ workflowFolder: result.filePaths[0] });
  });

  handle(IpcChannel.folderChoose, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "Choose the repository the session will run in",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    // The dialog is the consent, and this is where it is written down. The
    // renderer keeps the folder and passes it back to export later, so main
    // has to be able to say that a root it is handed came from here.
    return grants.grant(result.filePaths[0]);
  });

  // Opens the author's terminal on the CLI's own login command. Anthill never
  // sees a credential; the id is looked up in a table, so nothing that crosses
  // this channel becomes a command.
  handle(IpcChannel.interpreterSignIn, async (_event, id: string) =>
    signInToInterpreter(id),
  );

  handle(IpcChannel.pathsCheck, async (_event, paths: string[]) =>
    Object.fromEntries(
      (Array.isArray(paths) ? paths : [])
        .filter((path): path is string => typeof path === "string")
        .slice(0, 200)
        .map((path) => [path, existsSync(expandHome(path))]),
    ),
  );
  handle(IpcChannel.pathReveal, async (_event, path: string) => {
    if (typeof path !== "string") return false;
    const target = expandHome(path);
    // Checked here rather than trusted from the renderer: the renderer's own
    // check is about what to draw, and a path can stop existing between the
    // drawing and the click.
    if (!existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });

  // Prompt-to-Workflow. Detection and drafting only — nothing here runs a workflow.
  handle(IpcChannel.interpretersDetect, async (): Promise<InterpreterInfo[]> => {
    await userPath;
    return detectInterpreters();
  });

  // Read-only, and nothing is run: Codex keeps its own model catalogue on this
  // machine, and a hand-kept copy in Anthill's source would go stale on
  // somebody else's release schedule.
  handle(IpcChannel.codexModels, async () => {
    await userPath;
    const [catalog, agentSupport] = await Promise.all([
      readCodexModels(),
      readCodexAgentSupport(),
    ]);
    // The catalogue and the capability are separate questions: a CLI too old
    // for custom agents still lists its models perfectly well, and the screen
    // needs to offer the choice while saying it will not be applied.
    return { models: catalog?.models ?? [], ...(catalog?.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}), agentSupport };
  });

  // Read-only, and nothing is run: pi lists its models on request and keeps
  // no cache file, so the catalogue is asked for live and a missing CLI
  // leaves it `undefined` rather than an empty list.
  handle(IpcChannel.piModels, async () => {
    await userPath;
    return await readPiModels();
  });

  // One drafting run at a time, which is what the screen offers. Held here so
  // the cancel channel has something to abort.
  let drafting: AbortController | null = null;

  handle(
    IpcChannel.promptDraft,
    async (event, request: PromptDraftRequest): Promise<PromptDraftResponse> => {
      const granted = await grantedDraftFolder(request, draftFolders);
      if (granted.refused) return granted.refused;
      drafting?.abort();
      const controller = new AbortController();
      drafting = controller;
      try {
        return await runDraft({
          interpreterId: request.interpreterId,
          instruction: request.instruction,
          ...(granted.folder ? { folder: granted.folder } : {}),
          signal: controller.signal,
          onStage: (stage) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send(PROMPT_DRAFT_STAGE_CHANNEL, stage);
            }
          },
        });
      } finally {
        if (drafting === controller) drafting = null;
      }
    },
  );

  // The picker is the consent for a drafting CLI to read the folder, and the
  // grant is where it is written down. Directories only, and none created:
  // there is nothing to read in a folder made on the spot.
  handle(IpcChannel.promptFolderChoose, async (): Promise<DraftFolder | null> => {
    const result = await dialog.showOpenDialog({
      title: "Choose the project folder the CLI may read",
      buttonLabel: "Choose",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const path = await draftFolders.grant(result.filePaths[0]);
    return { path, displayPath: shortenHome(path) };
  });

  handle(IpcChannel.promptDraftCancel, async () => {
    drafting?.abort();
  });

  /* ---------------------------------------------------------------- */
  /* Live session auto-detection                                       */
  /* ---------------------------------------------------------------- */

  handle(IpcChannel.liveObserve, async (_event, request: LiveObserveRequest) => {
    const service = liveService();
    await service.start();
    const result = await service.startObservation(request);
    analytics.capture("live_observation_started");
    return result;
  });
  handle(IpcChannel.liveSnapshot, async () => liveService().start());
  handle(IpcChannel.liveCancel, async (_event, runId: string) =>
    liveService().cancelObservation(runId),
  );
  handle(IpcChannel.liveDismiss, async (_event, runId: string) =>
    liveService().dismiss(runId),
  );
  handle(IpcChannel.liveLookAgain, async (_event, runId: string) =>
    liveService().lookAgain(runId),
  );

  // The global agent library. Descriptions of intended agents; nothing runs.
  handle(IpcChannel.agentsList, async () => agentLibrary().load());
  handle(IpcChannel.agentsCreate, async (_event, input: GlobalAgentInput) =>
    agentLibrary().create(input),
  );
  handle(IpcChannel.agentsUpdate, async (_event, id: string, input: Partial<GlobalAgentInput>) =>
    agentLibrary().update(id, input),
  );
  handle(IpcChannel.agentsDuplicate, async (_event, id: string) =>
    agentLibrary().duplicate(id),
  );
  handle(IpcChannel.agentsRemove, async (_event, id: string) => agentLibrary().remove(id));

  /*
    The assistant's thread, per workflow.

    Read and written whole: the panel owns what a turn is and what the thread
    currently contains, and this side only remembers it faithfully. Clearing is
    its own channel because it is its own decision — closing the panel must
    never reach it (ANT-82).
  */
  handle(IpcChannel.assistantThreadRead, async (_event, workflowId: string) =>
    assistantThreadStore().read(workflowId),
  );
  handle(IpcChannel.assistantThreadWrite, async (_event, workflowId: string, turns: unknown[]) =>
    assistantThreadStore().write(workflowId, Array.isArray(turns) ? turns : []),
  );
  handle(IpcChannel.assistantThreadClear, async (_event, workflowId: string) =>
    assistantThreadStore().clear(workflowId),
  );

  handle(IpcChannel.modelPreferencesRead, async () => modelPreferences().read());
  handle(IpcChannel.modelPreferencesWrite, async (_event, next: unknown) => modelPreferences().write(next));
  // Read from the tools' own records on every ask: installing a plugin happens
  // in a terminal, and the page has to be right the next time it is opened.
  handle(IpcChannel.pluginStatus, async () => pluginStatus());
  // The plugin card: the records, plus the two things records cannot say —
  // whether the CLI runs, and whether the installed plugin's server answers.
  const appRoot = devCheckout(app.getAppPath(), app.isPackaged);
  const connectDeps = () => ({
    ...(appRoot ? { appRoot } : {}),
    interpreters: detectInterpreters,
    openUrl: (url: string) => shell.openExternal(url),
  });
  handle(IpcChannel.pluginConnections, async () => {
    await userPath;
    return pluginConnections(connectDeps());
  });
  // Runs the tool's own plugin commands, and only on the author's click.
  handle(IpcChannel.pluginInstall, async (_event, harness: unknown) => {
    if (!isCheckedPluginHarness(harness)) {
      return { ok: false, changed: false, error: "Unknown coding tool." };
    }
    await userPath;
    return installPlugin(harness, connectDeps());
  });
  // The same rule for Anthill's own pages: a name in, a listed address out.
  handle(IpcChannel.linkOpen, async (_event, name: unknown) => {
    const url = externalLink(name);
    if (url) await shell.openExternal(url);
  });
  // A fixed page per tool. The renderer names the tool, never the address.
  handle(IpcChannel.pluginGuide, async (_event, harness: unknown) => {
    if (isCheckedPluginHarness(harness)) await shell.openExternal(PLUGIN_HARNESS_INFO[harness].installGuide);
  });
  handle(IpcChannel.settingsRead, async () => settings().read());
  handle(IpcChannel.settingsWrite, async (_event, patch: Partial<AppSettings>) =>
    writeSettingsWithConsent(settings(), analytics, reporting, patch ?? {}, { nativeCrashes: true }),
  );
  // The CLI's browser page forwards its errors; the desktop renderer reports
  // through Sentry's own IPC, so there is nothing to do here.
  handle(IpcChannel.diagnosticsRendererError, async () => undefined);
  // Sent on demand, because "are notifications allowed" has no answer to read:
  // the author is being asked to look at their own screen.
  handle(IpcChannel.notificationsProbe, async () =>
    showNotification(
      "Anthill notifications are on",
      "This is what a step transition will look like.",
    ),
  );
  handle(IpcChannel.liveEvents, async (_event, runId: string) =>
    liveService().events(runId),
  );

  handle(
    IpcChannel.liveSetupStatus,
    async (_event, cwd?: string, refreshOnly?: boolean): Promise<ObservationSetupStatus> => liveSetupService().status(cwd, refreshOnly),
  );
  handle(
    IpcChannel.liveSetupDismiss,
    async (): Promise<ObservationSetupStatus> => liveSetupService().dismiss(),
  );
  // "Continue with basic progress" in the handover sheet. Declared in the
  // contract and bridged by the preload from the start, and never served, so
  // every decline failed and the same question came back next time (ANT-146).
  handle(
    IpcChannel.liveSetupDecline,
    async (_event, harness: MarkerCli): Promise<void> => liveSetupService().decline(harness),
  );
  handle(
    IpcChannel.liveSetupInstall,
    async (_event, harness: MarkerCli, cwd?: string): Promise<ObservationSetupActionResult> =>
      liveSetupService().install(harness, cwd),
  );
  handle(
    IpcChannel.liveSetupDisable,
    async (_event, harness: MarkerCli): Promise<ObservationSetupActionResult> =>
      liveSetupService().disable(harness),
  );

  // File ▸ Reveal in Finder follows the path in the editor's status bar.
  handle(IpcChannel.workflowSetRevealable, async (event, revealable: boolean) => {
    if (event.sender !== mainWindow?.webContents) return;
    const reveal = Menu.getApplicationMenu()?.getMenuItemById("reveal-workflow");
    if (reveal) reveal.enabled = revealable === true;
  });

  handle(IpcChannel.workflowSetDirty, async (_event, dirty: boolean) => {
    workflowDirty = Boolean(dirty);
    if (!workflowDirty) allowCloseWithUnsavedWorkflow = false;
  });

  handle(
    IpcChannel.workflowExport,
    async (_event, request: ExportWorkflowRequest): Promise<ExportWorkflowResponse> => {
      // A root the author has already chosen is not asked for again. The
      // dialog is the consent; asking on every copy would turn a decision into
      // a chore, and a chore into a step that gets skipped.
      let root: string;
      if (request.root) {
        // A root that arrives from the renderer is only as good as the dialog
        // it came from. One this process never handed out is confirmed in a
        // dialog pointing at it, never written to on the renderer's word
        // alone (ANT-200).
        const decided = await rootToWrite(request.root, grants, async (defaultPath) => {
          const result = await dialog.showOpenDialog({
            title: "Confirm the folder to write the agent files into",
            message: "Anthill remembered this folder from an earlier session. Confirm it to write the agent files.",
            buttonLabel: "Use This Folder",
            defaultPath,
            properties: ["openDirectory", "createDirectory"],
          });
          return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
        });
        if ("cancelled" in decided) return { ok: false, cancelled: true };
        root = decided.root;
      } else {
        const result = await dialog.showOpenDialog({
          title: "Choose the repository to write the workflow into",
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, cancelled: true };
        }
        root = await grants.grant(result.filePaths[0]);
      }

      try {
        const entries = [...request.files];
        if (request.prompt) {
          entries.push({ path: "anthill-prompt.md", content: request.prompt });
        }

        // Every destination is checked before anything is written. A refusal
        // half way through would leave some of a workflow's files in the
        // folder and the rest somewhere the user cannot see.
        const destinations: { path: string; content: string; relative: string }[] = [];
        for (const file of entries) {
          const destination = await destinationInside(root, file.path);
          if (!destination.ok) {
            return { ok: false, error: `Refusing to write outside the chosen folder: ${destination.reason}` };
          }
          destinations.push({ path: destination.path, content: file.content, relative: file.path });
        }

        // All of them or none: a failure part way through used to leave some
        // of the new agent files beside some of the old, matching no version
        // of the workflow (ANT-100).
        const outcome = await writeAllOrNothing(destinations);
        if (!outcome.ok) {
          return {
            ok: false,
            rolledBack: outcome.rolledBack,
            error: outcome.rolledBack
              ? `${outcome.error} The folder is as it was.`
              : `${outcome.error} Some files may have been replaced – check ${root} before using it.`,
          };
        }
        return { ok: true, directory: root, written: outcome.written };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

/*
  One instance, enforced.

  Two Anthills sharing one userData folder are two writers on every store this
  app owns: both observe the same sessions, and each appends journal events
  with its own fingerprint set — which is how one run's journal ended up with
  every event of a session recorded twice, interleaved. The second instance
  hands its argv to the first and exits; the first responds by fronting its
  window, which is what the person double-clicking again actually wanted.
*/
/*
  The lock, and in a development run, a short wait for it.

  The dev watcher restarts Electron by signalling the running app and
  spawning the replacement at once, without waiting (electron-vite 2.3), and
  it ends itself — dev server and all — when any Electron it spawned exits.
  The replacement therefore always meets a lock its predecessor has not let
  go of yet; quitting on the spot is what took the dev server down (ANT-72).
  In development it waits up to five seconds for the predecessor to finish
  quitting. A packaged app never waits: a second launch there is a person
  double-clicking, and the answer is to hand over and go.
*/
const INSTANCE_LOCK_WAIT_MS = 5_000;
const lockHeld: Promise<boolean> = (() => {
  if (app.requestSingleInstanceLock()) return Promise.resolve(true);
  if (app.isPackaged) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (app.requestSingleInstanceLock()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= INSTANCE_LOCK_WAIT_MS) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
})();

void lockHeld.then((held) => {
  if (!held) {
    app.quit();
    return;
  }
  app.on("second-instance", (_event, argv) => {
    // An app on its way out does not open a window for a newcomer: that is
    // the replacement asking for the lock, and a window reopened here would
    // keep this process alive in its way.
    if (quitting) {
      // In a development run that newcomer is the watcher's restart, and it
      // gives up after five seconds — taking the dev server with it. This
      // process may be stuck on "Discard changes?" for an unsaved workflow:
      // the signal handlers below never ran, because Chromium takes SIGTERM
      // itself and turns it into an ordinary quit (ANT-150). Nobody asked to
      // keep this build; the one replacing it is what the developer is
      // waiting for. A packaged app is never replaced this way.
      if (!app.isPackaged) app.exit(0);
      return;
    }
    for (const link of linksFromArgv(argv)) receiveLink(link);
    workflowWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
});

app.on("before-quit", () => {
  quitting = true;
});

/*
  A signal is not a person closing a window.

  Nobody is there to answer "discard changes?", so a SIGTERM, SIGINT or
  SIGHUP quits without asking — the way a terminal's Ctrl-C and the dev
  watcher's restart both expect. What the person had open is what autosave
  and the working copy are for. If the orderly quit is still in progress
  after three seconds, the process ends anyway: a signal that is ignored is
  the bug this replaces.

  Not to be relied on alone: on macOS, Electron 42's Chromium handles
  SIGTERM itself — `before-quit` and the window's `close` arrive, and these
  handlers never run (measured with a bare probe, ANT-150). The dev restart is
  therefore also recognised by the replacement asking for the lock; see the
  `second-instance` handler.
*/
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    quitting = true;
    allowCloseWithUnsavedWorkflow = true;
    app.quit();
    setTimeout(() => app.exit(0), 3_000).unref();
  });
}

// macOS can deliver this before ready; only the window work is deferred.
app.on("open-url", (event, url) => { event.preventDefault(); receiveLink(url); });
for (const url of linksFromArgv(process.argv)) receiveLink(url);

/**
 * The menu bar, for the one item that has to live there.
 *
 * macOS puts Settings under the app menu with ⌘, and people look for it there
 * rather than on a page. Live Observation used to be managed from a button in
 * the workflow header; that button is gone, because setting it up belongs in
 * the handover where the deadline is, and managing it afterwards belongs
 * somewhere reachable at any time from anywhere.
 *
 * Built from roles so every standard item keeps its standard behaviour, and
 * the app menu's own title comes from the bundle — which is why the packaged
 * build says Anthill and a dev run says Electron (ANT-13).
 */
/** Undo or Redo from the Edit menu: the text field's own, and the page's (ANT-192). */
function editHistory(window: unknown, action: "undo" | "redo"): void {
  const target = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow();
  if (!target) return;
  // Typing in a field is undone where it happened; outside one this does
  // nothing, and the page is told instead.
  if (action === "undo") target.webContents.undo();
  else target.webContents.redo();
  target.webContents.send(EDIT_HISTORY_CHANNEL, action);
}

function applyMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Settings…",
            accelerator: "CmdOrCtrl+,",
            click: () => {
              BrowserWindow.getAllWindows()[0]?.webContents.send(OPEN_SETTINGS_CHANNEL);
            },
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        // Spelled out rather than taken from the role, because the role's File
        // menu has no Save in it. Save is a menu item and not a key handler in
        // the page so that one press is exactly one save, and so the shortcut
        // is written down where people look for it (ANT-59).
        label: "File",
        submenu: [
          {
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            // The window the menu fired for, so a second window saves its own
            // document and not whatever happens to be first in the list.
            click: (_item, window) => {
              const target =
                window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow();
              target?.webContents.send(SAVE_WORKFLOW_CHANNEL);
            },
          },
          {
            id: "reveal-workflow",
            // As the status bar says it (ANT-206): Finder by name on macOS.
            label: process.platform === "darwin" ? "Reveal in Finder" : "Show in Folder",
            enabled: false,
            click: (_item, window) => {
              const target = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow();
              target?.webContents.send(REVEAL_WORKFLOW_CHANNEL);
            },
          },
          { type: "separator" },
          { role: "close" },
        ],
      },
      /*
        Spelled out for Undo and Redo, as File is for Save. The role's Undo
        took ⌘Z before the page saw it and undid nothing outside a text field,
        so the canvas shortcut was dead in the app (ANT-192). These still undo
        typing — the text field's own undo — and tell the page, which steps
        the workflow's history when no text field has focus.
      */
      {
        label: "Edit",
        submenu: [
          {
            label: "Undo",
            accelerator: "CmdOrCtrl+Z",
            click: (_item, window) => editHistory(window, "undo"),
          },
          {
            label: "Redo",
            accelerator: "Shift+CmdOrCtrl+Z",
            click: (_item, window) => editHistory(window, "redo"),
          },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

void app.whenReady().then(async () => {
  // Nothing opens until this process holds the lock; a development run may
  // still be waiting for its predecessor to let go (ANT-72).
  if (!(await lockHeld)) return;
  // The installed app only, and reclaimed whenever it comes back to the front
  // having lost it — see url-scheme.ts for why a dev run must not (ANT-137).
  claimScheme(app);
  app.on("did-become-active", () => claimScheme(app));
  // History is opened lazily; the editor does not depend on the legacy store.
  applyAppIcon();
  applyMenu();
  setRecentsPaths({ userData: app.getPath("userData"), home: app.getPath("home") });
  registerIpcHandlers();
  if ((await settings().read()).analyticsEnabled) {
    await analytics.enable().then(() => analytics.capture("desktop_opened")).catch(() => undefined);
  }
  createWindow();

  // Reading what a coding harness left in the exchange, from here on. Started
  // after the window so the first workflow it finds has somewhere to go.
  exchangeInbox().start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// before-quit can still be cancelled by the unsaved-workflow dialog.
app.on("will-quit", () => {
  inbox?.stop();
  live?.stop();
  void services?.store.close?.();
});
