/**
 * @uipi/protocol — shared WebSocket message types between any uipi client
 * (web, future TUI) and the server. Zero dependencies, environment-agnostic.
 *
 * Two namespaces:
 *  - `proto.*`  — uipi lifecycle (connection, session management, attach)
 *  - `pi.evt.*` — pi SDK session events forwarded verbatim (typed loosely here;
 *                 the server imports concrete types from pi, clients treat
 *                 these payloads opaquely or map known event shapes)
 */

// ---------- Client → Server ----------

export type C2S =
  | { type: "proto.listSessions" }
  | { type: "proto.newSession"; cwd: string; agentDir?: string }
  | {
      type: "proto.attach";
      sessionId: string;
    }
  | { type: "proto.detach"; sessionId: string }
  | { type: "proto.openSession"; sessionFilePath: string }
  | { type: "proto/recentDirs" }
  | { type: "proto/listModels" }
  | { type: "pi.prompt"; sessionId: string; text: string }
  | { type: "pi.steer"; sessionId: string; text: string }
  | { type: "pi.followUp"; sessionId: string; text: string }
  | { type: "pi.abort"; sessionId: string }
  | { type: "pi.setModel"; sessionId: string; provider: string; modelId: string }
  | { type: "pi.setThinkingLevel"; sessionId: string; level: string }
  | { type: "pi.compact"; sessionId: string }
  | { type: "pi.cancelQueued"; sessionId: string; kind: "steer" | "followUp"; index: number }
  // extension UI bridge responses
  | {
      type: "ui.dialogResponse";
      sessionId: string;
      dialogId: string;
      value: unknown;
    }
  | {
      type: "ui.selectResponse";
      sessionId: string;
      selectId: string;
      index: number | null;
    };

// ---------- Server → Client ----------

export interface Attachment extends Excerpt {
  /** live pi events accumulated since attach (client-side transcript projection) */
  events: unknown[];
  [key: string]: unknown;
}

export type Excerpt = {
  sessionId: string;
  cwd: string;
  isStreaming: boolean;
  messages: unknown[];
  steering: unknown[];
  followUp: unknown[];
};

export interface SessionSummary {
  sessionId: string;
  sessionFile: string;
  displayName: string;
  firstMessage: string;
  mtime: number;
  /** undefined if not currently materialized in the server */
  live: boolean;
  cwd: string;
}

export interface RecentDir {
  path: string;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  reasoning: boolean;
  contextWindow: number;
}

export type UiDialogRequest = {
  kind: "dialog";
  dialogId: string;
  sessionId: string;
  title: string;
  /** Optional pre-defined choices; unknown shapes carry raw payload */
  payload?: unknown;
};

export type UiSelectRequest = {
  kind: "select";
  selectId: string;
  sessionId: string;
  title: string;
  options: { label: string; value?: unknown }[];
};

export type UiNotification = {
  kind: "notification";
  sessionId: string;
  level: "info" | "warn" | "error";
  message: string;
};

export type UiEvent = UiDialogRequest | UiSelectRequest | UiNotification;

export interface S2CBase {
  /** correlation id for a command reply */
  id?: string;
}

export type S2C = S2CBase &
  (
    | { type: "proto.error"; message: string; requestId?: string }
    | { type: "proto.sessions"; sessionId?: string; sessions: SessionSummary[] }
    | { type: "proto.recentDirs"; dirs: RecentDir[] }
    | { type: "proto.models"; models: ModelInfo[] }
    | {
        type: "proto.attached";
        sessionId: string;
        /** Serialized transcript snapshot from session.messages */
        messages: unknown[];
        model: { provider: string; modelId: string } | null;
        thinkingLevel: string;
        tools: string[];
        cwd: string;
        isStreaming: boolean;
        steering: unknown[];
        followUp: unknown[];
        /** stable session file path (durable across reloads; live sessions only) */
        sessionFile: string | null;
      }
    | { type: "proto.detached"; sessionId: string }
    | {
        type: "proto.modelSet";
        sessionId: string;
        model: { provider: string; modelId: string } | null;
      }
    | { type: "ui.event"; event: UiEvent }
    | { type: "pi.evt"; sessionId: string; event: unknown }
  );
