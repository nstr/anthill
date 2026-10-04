import { externalLink } from "../../desktop/src/shared/links.js";
import type { InterpreterId } from "@anthill/workflow";
import { routedWorkflowId } from "./routes.js";
import {
  IPC_CONTRACT,
  IpcChannel,
  LIVE_EVENTS_CHANNEL,
  LIVE_SNAPSHOT_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  HANDOVER_REFUSED_CHANNEL,
  OPEN_WORKFLOW_CHANNEL,
  SAVE_WORKFLOW_CHANNEL,
  PROMPT_DRAFT_STAGE_CHANNEL,
  type AnthillApi,
  type ApprovalResponse,
  type ExportWorkflowRequest,
  type LiveObserveRequest,
  type ObservationEvent,
  type LiveSnapshot,
  type MarkerCli,
  type PromptDraftRequest,
  type PromptDraftStage,
  type RunEvent,
  type SaveWorkflowRequest,
  type StartRunRequest,
  type GlobalAgentInput,
} from "../../desktop/src/shared/ipc.js";

/**
 * The CLI's answer to the desktop's preload script.
 *
 * In Electron, `window.anthill` is injected by `src/preload/index.ts`. In a
 * browser tab there is no preload, so this module installs the same
 * `AnthillApi` over the WebSocket at `/api`: each method is a
 * request/response round trip, and each `on*` subscription is a push
 * channel delivered by the server. It runs only when `window.anthill` is
 * absent, so the same renderer bundle works in both shells unchanged.
 *
 * Bundled by vite (see `vite.config.ts`), not by tsc: this file is
 * deliberately excluded from the CLI tsconfig, which type-checks only the
 * main-process files.
 */

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

/**
 * A server-side failure arrives over the wire as a plain value (a string, or a
 * small object) — an `Error` does not survive JSON. Wrap it so the renderer
 * always rejects with a real `Error`, not a bare string it has to String() to
 * read.
 */
function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message: unknown }).message;
    return new Error(typeof message === "string" ? message : String(message));
  }
  return new Error(String(reason));
}

type PushMessage = {
  channel?: unknown;
  payload?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

/**
 * Open the connection to the CLI and install `window.anthill`.
 *
 * The message protocol is shared with the bridge: a request is
 * `{ id, channel, args }`, a response is `{ id, channel, result }` or
 * `{ id, channel, error }`, and a push is `{ channel, payload }`. One pending
 * promise per request id; push channels are fanned out to the `on*` listeners.
 */
export function installWebBridge(): Promise<AnthillApi> {
  return new Promise((resolve, reject) => {
    const protocol =
      window.location.protocol === "https:" ? "wss:" : "ws:";
    // The token the server requires to open /api. It comes from the URL the
    // CLI printed (served only on loopback); a page on another origin never
    // has it, so it cannot open the socket.
    const token = new URLSearchParams(window.location.search).get("token");
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api` +
        (token ? `?token=${encodeURIComponent(token)}` : ""),
    );

    /**
     * Whether this page has handed over the workflow its URL names (ANT-228).
     *
     * A tab at `/workflow/<id>` is this shell's `anthill://workflow/<id>`. The id
     * goes with the first collection only: the page asks again when a screen
     * remounts, and a link is followed once. A reload is a new page, and follows it
     * again, as reopening a link would.
     */
    let routeHandedOver = false;
    const pending = new Map<number, Pending>();
    const pushHandlers = new Map<string, Set<(payload: unknown) => void>>();
    let nextId = 1;

    socket.addEventListener("close", () => {
      // A dropped connection rejects every in-flight request rather than
      // leaving the renderer waiting on a round trip that will never land.
      for (const request of pending.values()) {
        request.reject(new Error("The connection to the CLI was closed."));
      }
      pending.clear();
    });

    socket.addEventListener("message", (event) => {
      let message: PushMessage;
      try {
        message = JSON.parse(String(event.data)) as PushMessage;
      } catch {
        return;
      }
      // A response carries an `id` and either a `result` or an `error`.
      if (message.id !== undefined) {
        const request = pending.get(message.id as number);
        if (!request) return;
        pending.delete(message.id as number);
        if (message.error !== undefined) request.reject(toError(message.error));
        else request.resolve(message.result);
        return;
      }
      // A push carries a `channel` and a `payload`, no `id`.
      if (typeof message.channel === "string") {
        const handlers = pushHandlers.get(message.channel);
        if (handlers) for (const handler of handlers) handler(message.payload);
      }
    });

    // A request/response round trip over the WebSocket. `installWebBridge`
    // only resolves once the socket is open, so by the time a renderer calls
    // a method the socket is ready; the `open` guard covers the edge where a
    // call lands in the gap between `readyState` flipping and the first send.
    // A socket that is already closing or closed will never (re)open, so
    // waiting on `open` there would hang the request forever — reject instead.
    const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const send = (): void => {
          socket.send(JSON.stringify({ id, channel, args }));
        };
        if (socket.readyState === WebSocket.OPEN) {
          send();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          // Not open yet, but it will be: wait for `open`.
          socket.addEventListener("open", send, { once: true });
        } else {
          // CLOSING or CLOSED: it will never (re)open. Reject now and drop
          // the pending entry so the `close` handler does not double-reject.
          pending.delete(id);
          reject(new Error("The connection to the CLI is closed."));
        }
      });
    };

    // A push-channel subscription. Returns an unsubscribe, like the preload.
    const onChannel = (
      channel: string,
      listener: (payload: unknown) => void,
    ): (() => void) => {
      let handlers = pushHandlers.get(channel);
      if (!handlers) {
        handlers = new Set();
        pushHandlers.set(channel, handlers);
      }
      handlers.add(listener);
      return () => {
        handlers?.delete(listener);
      };
    };

    const api = {
      contract: IPC_CONTRACT,
      capabilities: () => invoke(IpcChannel.appCapabilities),
      relaunch: () => invoke(IpcChannel.appRelaunch),
      openWorkflow: (path?: string) => invoke(IpcChannel.workflowOpen, path),
      pendingWorkflowOpen: () => {
        const routed = routeHandedOver ? undefined : routedWorkflowId(window.location.pathname);
        routeHandedOver = true;
        return invoke(IpcChannel.workflowPendingOpen, ...(routed ? [routed] : []));
      },
      workflowOpened: (path, deliveryId, outcome) => invoke(IpcChannel.workflowOpened, path, deliveryId, outcome),
      exchangeRead: (path, id) => invoke(IpcChannel.exchangeRead, path, id),
      liveWorkflow: (runId) => invoke(IpcChannel.liveWorkflow, runId),
      // One payload per push: the path and the delivery id the page
      // acknowledges with travel together.
      onOpenWorkflow: (listener: (path: string, deliveryId?: number) => void) =>
        onChannel(OPEN_WORKFLOW_CHANNEL, (payload) => {
          const { path, deliveryId } = payload as { path: string; deliveryId?: number };
          listener(path, deliveryId);
        }),
      saveWorkflow: (request: SaveWorkflowRequest) =>
        invoke(IpcChannel.workflowSave, request),
      onSaveWorkflow: (listener: () => void) =>
        onChannel(SAVE_WORKFLOW_CHANNEL, () => listener()),
      listRuns: () => invoke(IpcChannel.runList),
      getRun: (runId: string) => invoke(IpcChannel.runGet, runId),
      exportWorkflow: (request: ExportWorkflowRequest) =>
        invoke(IpcChannel.workflowExport, request),
      setWorkflowDirty: (dirty: boolean) =>
        invoke(IpcChannel.workflowSetDirty, dirty),
      listRecentPlans: () => invoke(IpcChannel.recentsList),
      forgetRecentWorkflow: (path: string) =>
        invoke(IpcChannel.recentsForget, path),
      chooseRunFolder: () => invoke(IpcChannel.folderChoose),
      signInToInterpreter: (id: InterpreterId) =>
        invoke(IpcChannel.interpreterSignIn, id),
      pathsExist: (paths: string[]) => invoke(IpcChannel.pathsCheck, paths),
      revealPath: (path: string) => invoke(IpcChannel.pathReveal, path),
      detectInterpreters: () => invoke(IpcChannel.interpretersDetect),
      codexModels: () => invoke(IpcChannel.codexModels),
      piModels: () => invoke(IpcChannel.piModels),
      draftFromPrompt: (request: PromptDraftRequest) =>
        invoke(IpcChannel.promptDraft, request),
      cancelPromptDraft: () => invoke(IpcChannel.promptDraftCancel),
      chooseDraftFolder: () => invoke(IpcChannel.promptFolderChoose),
      onPromptDraftStage: (listener: (stage: PromptDraftStage) => void) =>
        onChannel(PROMPT_DRAFT_STAGE_CHANNEL, (payload) =>
          listener(payload as PromptDraftStage),
        ),
      liveObserve: (request: LiveObserveRequest) =>
        invoke(IpcChannel.liveObserve, request),
      liveSnapshot: () => invoke(IpcChannel.liveSnapshot),
      liveCancel: (runId: string) => invoke(IpcChannel.liveCancel, runId),
      liveDismiss: (runId: string) => invoke(IpcChannel.liveDismiss, runId),
      liveLookAgain: (runId: string) => invoke(IpcChannel.liveLookAgain, runId),
      liveLastRun: (workflowId: string) => invoke(IpcChannel.liveLastRun, workflowId),
      agentsList: () => invoke(IpcChannel.agentsList),
      agentsCreate: (input: GlobalAgentInput) =>
        invoke(IpcChannel.agentsCreate, input),
      agentsUpdate: (id: string, input: Partial<GlobalAgentInput>) =>
        invoke(IpcChannel.agentsUpdate, id, input),
      agentsDuplicate: (id: string) => invoke(IpcChannel.agentsDuplicate, id),
      agentsRemove: (id: string) => invoke(IpcChannel.agentsRemove, id),
      liveEvents: (runId: string) => invoke(IpcChannel.liveEvents, runId),
      onLiveEvents: (
        listener: (payload: { runId: string; events: ObservationEvent[] }) => void,
      ) =>
        onChannel(LIVE_EVENTS_CHANNEL, (payload) =>
          listener(payload as { runId: string; events: ObservationEvent[] }),
        ),
      onOpenSettings: (listener: () => void) =>
        onChannel(OPEN_SETTINGS_CHANNEL, () => listener()),
      onLiveSnapshot: (listener: (snapshot: LiveSnapshot) => void) =>
        onChannel(LIVE_SNAPSHOT_CHANNEL, (payload) =>
          listener(payload as LiveSnapshot),
        ),
      settingsRead: () => invoke(IpcChannel.settingsRead),
      reportRendererError: (event: unknown) => invoke(IpcChannel.diagnosticsRendererError, event),
      // The page is already in a browser: a listed page opens in a new tab,
      // with no way back to this one.
      openLink: async (name: unknown) => {
        const url = externalLink(name);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      },
      settingsWrite: (patch: unknown) => invoke(IpcChannel.settingsWrite, patch),
      notificationsProbe: () => invoke(IpcChannel.notificationsProbe),
      pluginStatus: () => invoke(IpcChannel.pluginStatus),
      pluginConnections: () => invoke(IpcChannel.pluginConnections),
      pluginInstall: (harness: string) => invoke(IpcChannel.pluginInstall, harness),
      liveSetupStatus: (cwd?: string, refreshOnly?: boolean) => invoke(IpcChannel.liveSetupStatus, cwd, refreshOnly),
      liveSetupDecline: (harness: MarkerCli) => invoke(IpcChannel.liveSetupDecline, harness),
      liveSetupDismiss: () => invoke(IpcChannel.liveSetupDismiss),
      liveSetupInstall: (harness: MarkerCli, cwd?: string) =>
        invoke(IpcChannel.liveSetupInstall, harness, cwd),
      liveSetupDisable: (harness: MarkerCli) =>
        invoke(IpcChannel.liveSetupDisable, harness),
    } as AnthillApi;

    // The desktop's "could not carry out a handover" box: a tab has no native
    // one, so the sentence the bridge pushes is shown the plainest way a page
    // can. It is rare, and it is about something the user just asked for.
    onChannel(HANDOVER_REFUSED_CHANNEL, (message) => {
      window.alert(`Anthill could not carry out a handover\n\n${String(message)}`);
    });

    // `installWebBridge` resolves once the socket is open and `window.anthill`
    // is installed, so a renderer that awaits it can start calling immediately.
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      socket.addEventListener("open", () => {
        window.anthill = api;
        resolveReady();
      });
      socket.addEventListener("error", () =>
        rejectReady(new Error("Could not reach the CLI at /api.")),
      );
    });

    void ready.then(() => resolve(api));
    void ready.catch((error) => reject(error));
  });
}
