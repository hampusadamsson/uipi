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

/**
 * A fixed, server-owned allowlist of editable config documents. The client
 * names a document, never a path, so no request can reach `auth.json`,
 * `mcp-auth.json` or anything under `sessions/` — the server maps the id to a
 * path itself and cannot be talked out of that mapping.
 */
export type ConfigId = "settings" | "roles" | "sandbox" | "mcp";

/**
 * What a `proto.reloadConfig` request re-reads across live sessions. Only the
 * documents pi can take on mid-session are here: `sandbox`/`mcp` are read at
 * session start and have no reload of their own, so they are not offered.
 */
export type ReloadWhat = "settings" | "roles" | "skills";

/**
 * A raw config document plus the mtime it was read at. The client echoes the
 * mtime back on save so the server can detect a concurrent edit instead of
 * silently clobbering it.
 */
export interface ConfigDoc {
  /**
   * Which document this is. Named `docId`, not `id`: `S2CBase.id` is the
   * transport's correlation id, and `Conn.request` stamps it onto the outgoing
   * frame, so a payload field called `id` would be overwritten.
   */
  docId: ConfigId;
  mtimeMs: number;
  text: string;
}

// ---------- Client → Server ----------

export type C2S =
  | { type: "proto.listSessions" }
  | { type: "proto.newSession"; cwd: string; agentDir?: string }
  | {
      type: "proto.attach";
      sessionId: string;
    }
  | { type: "proto.setRole"; sessionId: string; role: string | null; reload?: boolean }
  /**
   * Ask for the role names the `/role` extension command offers as argument
   * completions. Same discriminant as the reply, like `proto.recentDirs`: the
   * request carries no payload beyond the session, so the direction is
   * unambiguous.
   */
  | { type: "proto.roleNames"; sessionId: string }
  /**
   * Ask what skills pi discovers for one cwd. Same discriminant as the reply,
   * like `proto.recentDirs`: the request carries the query (`cwd`), the reply
   * carries the result (`skills`), and no other payload is shared, so the
   * direction is unambiguous.
   */
  | { type: "proto.skills"; cwd: string; agentDir?: string }
  /**
   * List the editable config documents. Same discriminant as the reply, like
   * `proto.recentDirs`: the request carries no payload, the reply carries the
   * ids and mtimes, so the direction is unambiguous.
   */
  | { type: "proto.configList" }
  /**
   * Read one config document. Same discriminant as the reply (request has the
   * docId, reply has the doc), so no request can name a path directly.
   */
  | { type: "proto.configGet"; docId: ConfigId }
  /**
   * Write one config document back. `mtimeMs` is the value the client last
   * read; a mismatch means someone else edited the file and the server answers
   * with `proto.configConflict` rather than overwriting it.
   */
  | { type: "proto.configUpdate"; docId: ConfigId; mtimeMs: number; text: string }
  /**
   * Re-read one config document on every live session.
   *
   * Reload is explicit, never implicit on save: pi reads its config at session
   * start, so a silent reload would change a running agent mid-conversation. The
   * user asks for it, and the server tells them which sessions it reached.
   */
  | { type: "proto.reloadConfig"; what: ReloadWhat }
  /**
   * Create, overwrite or remove one of pi's skills by name. The server resolves
   * name → file (project or user scope) itself; no path crosses the wire.
   */
  | {
      type: "proto.skillWrite";
      op: "create" | "update" | "delete";
      name: string;
      frontmatter?: string;
      body?: string;
    }
  /**
   * Read one skill back. The editor needs the real file so it can round-trip
   * keys it does not understand; `name` is a slug the server validates, never a
   * path.
   */
  | { type: "proto.skillGet"; name: string }
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
  /** active role, or null when roleless */
  role: string | null;
}

export interface RecentDir {
  path: string;
}

/**
 * pi's own skills for one cwd: user skills from the agent dir plus project
 * skills from `<cwd>/.pi/skills`. uipi only lists them — installation and
 * invocation stay with pi.
 */
export interface SkillInfo {
  name: string;
  description: string;
  scope: "user" | "project";
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  reasoning: boolean;
  contextWindow: number;
}

/**
 * Every UI event carries a server-assigned `id`. Frontends drop an event once
 * they have presented it, and object identity is useless for that: the wire
 * hands out a fresh object per delivery and reactive stores wrap it in proxies,
 * so removal must key on this stable id instead.
 */
type UiEventBase = {
  /** stable per-event key, assigned by the server when the event is created */
  id: string;
};

export type UiDialogRequest = UiEventBase & {
  kind: "dialog";
  dialogId: string;
  sessionId: string;
  title: string;
  /** Optional pre-defined choices; unknown shapes carry raw payload */
  payload?: unknown;
};

export type UiSelectRequest = UiEventBase & {
  kind: "select";
  selectId: string;
  sessionId: string;
  title: string;
  options: { label: string; value?: unknown }[];
};

/**
 * Which uipi-initiated command caused a notification. The server tags the
 * notifications it triggers itself, so a frontend that already mirrors that
 * state can suppress the confirmation without parsing its text (the extension
 * owns the wording, and `ctx.ui.notify` has no tag parameter of its own).
 */
export type UiNotificationOrigin = "setRole";

export type UiNotification = UiEventBase & {
  kind: "notification";
  sessionId: string;
  level: "info" | "warn" | "error";
  message: string;
  /** absent for notifications an extension raised on its own initiative */
  origin?: UiNotificationOrigin;
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
    | { type: "proto.skills"; skills: SkillInfo[] }
    /**
     * Ids plus mtimes only: the editor needs the list to know what exists and
     * whether a doc changed, without shipping every document's full text.
     */
    // entries keep `id`: it is nested inside `docs`, so the frame's top-level
    // correlation `id` never reaches it
    | { type: "proto.configList"; docs: { id: ConfigId; mtimeMs: number }[] }
    | { type: "proto.configGet"; doc: ConfigDoc }
    | { type: "proto.configUpdate"; doc: ConfigDoc }
    /**
     * Acknowledgements carry just the skill name the server acted on, so the UI
     * can refresh that entry without refetching the whole skill list.
     */
    | { type: "proto.skillWrite"; name: string }
    /**
     * The real SKILL.md, split into its raw frontmatter lines and body, so the
     * editor can show what is on disk instead of guessing at it.
     */
    | { type: "proto.skillGet"; name: string; frontmatter: string; body: string }
    /**
     * The write lost a race: `mtimeMs`/`text` are the current on-disk version,
     * so the UI can show a diff or offer a reload instead of discarding work.
     */
    | { type: "proto.configConflict"; docId: ConfigId; mtimeMs: number; text: string }
    | {
        /**
         * Ids of the live sessions the reload was applied to. Empty means there
         * was nothing to reload — a success, not an error. Every target failing
         * answers `proto.error` instead.
         */
        type: "proto.reloadConfig";
        what: string;
        sessions: string[];
      }
    | { type: "proto.models"; models: ModelInfo[] }
    | {
        type: "proto.attached";
        sessionId: string;
        /** Serialized transcript snapshot from session.messages */
        messages: unknown[];
        model: { provider: string; modelId: string } | null;
        thinkingLevel: string;
        tools: string[];
        /** active role name, or null when roleless */
        role: string | null;
        /** discoverable slash commands (extension, prompt templates, skills) */
        commands: { name: string; description?: string }[];
        /** extension status slots (key → text) */
        statuses: Record<string, string>;
        cwd: string;
        isStreaming: boolean;
        steering: unknown[];
        followUp: unknown[];
        /** stable session file path (durable across reloads; live sessions only) */
        sessionFile: string | null;
      }
    | {
        /**
         * Role names from `/role`'s own argument completions, reserved words
         * (`none`, `reload`, `keys`) filtered out. Empty when the roles
         * extension is not installed or completions fail — the picker degrades
         * to `(none)` + reload rather than erroring.
         */
        type: "proto.roleNames";
        sessionId: string;
        names: string[];
      }
    | { type: "proto.detached"; sessionId: string }
    | {
        /** full runtime state of a session after a change (model, role, tools, …) */
        type: "proto.sessionState";
        sessionId: string;
        /** active role name, or null when roleless */
        role: string | null;
        model: { provider: string; modelId: string } | null;
        thinkingLevel: string;
        tools: string[];
        /** discoverable slash commands (extension, prompt templates, skills) */
        commands: { name: string; description?: string }[];
      }
    | {
        /** extension status slots (key → text), replaced wholesale */
        type: "proto.statuses";
        sessionId: string;
        statuses: Record<string, string>;
      }
    | {
        /** queued (waiting) messages for a running agent */
        type: "proto.queues";
        sessionId: string;
        steering: unknown[];
        followUp: unknown[];
      }
    | { type: "ui.event"; event: UiEvent }
    | { type: "pi.evt"; sessionId: string; event: unknown }
  );
