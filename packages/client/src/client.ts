import type { ModelInfo, SessionSummary, C2S, S2C, UiEvent } from "@uipi/protocol";
import type { Conn } from "./conn.js";
import { pathFor, hash8, hashFromPath } from "./route.js";

/** The server's attach payload, as it appears on the wire. */
type AttachedMsg = Extract<S2C, { type: "proto.attached" }>;

/**
 * A session the client is attached to. `events` holds raw pi events received
 * since attach; `messages` is the snapshot taken at attach time. Together they
 * are the input to {@link deriveTranscript}.
 */
export interface AttachedSession {
  sessionId: string;
  cwd: string;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  tools: string[];
  /** active role name, or null when roleless */
  role: string | null;
  /** discoverable slash commands (extension, prompt templates, skills) */
  commands: { name: string; description?: string }[];
  /** extension status slots (key → text) */
  statuses: Record<string, string>;
  isStreaming: boolean;
  steering: unknown[];
  followUp: unknown[];
  sessionFile: string | null;
  /** transcript snapshot at attach time */
  messages: unknown[];
  /** live pi events since attach */
  events: unknown[];
}

export interface SessionSummaryView extends SessionSummary {
  /** true when this summary refers to the currently attached session */
  active: boolean;
}

export type RunState = "idle" | "thinking" | "streaming" | "tooling";

/**
 * Framework-agnostic client store: owns the connection, the attached sessions,
 * the pi-event reducer and every command a frontend can issue.
 *
 * No DOM, no framework. UI layers subscribe via {@link onChange} and read the
 * exposed fields; each frontend decides how to surface them (Svelte runes, a
 * TUI render loop, tests). This is the single abstraction every frontend uses.
 */
export class UipiClient {
  readonly conn: Conn;

  connected = false;
  sessions: SessionSummary[] = [];
  recentDirs: string[] = [];
  models: ModelInfo[] = [];
  activeId: string | null = null;
  error: string | null = null;

  private attachedSessions = new Map<string, AttachedSession>();
  private runStateById = new Map<string, RunState>();
  private liveEventsById = new Map<string, unknown[]>();
  private sentMessagesById = new Map<string, string[]>();
  private contextTokensById = new Map<string, number>();
  private pendingModelById = new Map<string, { provider: string; modelId: string }>();
  private uiEvents: UiEvent[] = [];
  private listeners = new Set<() => void>();

  /**
   * Called after the initial connect has loaded sessions, models and recent
   * dirs. A frontend restores its own view state here (the web app reopens the
   * session named by the URL). Awaited before the client finishes connecting.
   */
  onReady: (client: UipiClient) => void | Promise<void> = () => {};

  constructor(conn: Conn) {
    this.conn = conn;
    conn.onOpen = () => {
      this.connected = true;
      void this.onConnect();
    };
    conn.onClose = () => {
      this.connected = false;
      this.emit();
    };
    conn.onMessage = (m) => this.handle(m);
  }

  // ---------------------------------------------------------------- reads

  /** Subscribe to any state change. Returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attach(): void {
    this.conn.connect();
  }

  getAttached(sessionId: string): AttachedSession | undefined {
    return this.attachedSessions.get(sessionId);
  }

  get attachedSessionsList(): AttachedSession[] {
    return [...this.attachedSessions.values()];
  }

  get active(): AttachedSession | undefined {
    return this.activeId ? this.attachedSessions.get(this.activeId) : undefined;
  }

  stateOf(sessionId: string | null): RunState {
    if (!sessionId) return "idle";
    return this.runStateById.get(sessionId) ?? "idle";
  }

  liveEvents(sessionId: string): unknown[] {
    return this.liveEventsById.get(sessionId) ?? [];
  }

  sentMessages(sessionId: string): string[] {
    return this.sentMessagesById.get(sessionId) ?? [];
  }

  contextTokens(sessionId: string): number | undefined {
    return this.contextTokensById.get(sessionId);
  }

  /** Locally echoed model choice, set until the server confirms it. */
  pendingModel(sessionId: string): { provider: string; modelId: string } | undefined {
    return this.pendingModelById.get(sessionId);
  }

  /** Model actually in effect: optimistic echo, else the attached value. */
  effectiveModel(sessionId: string): { provider: string; modelId: string } | null | undefined {
    return this.pendingModel(sessionId) ?? this.attachedSessions.get(sessionId)?.model;
  }

  getUiEvents(): readonly UiEvent[] {
    return this.uiEvents;
  }

  sessionSummaries(): SessionSummaryView[] {
    return this.sessions.map((s) => ({ ...s, active: s.sessionId === this.activeId }));
  }

  /** URL path for the active session (or "/"). */
  activePath(): string {
    return pathFor(this.active?.sessionFile ?? null);
  }

  // ------------------------------------------------------------- commands

  async refreshSessions(): Promise<void> {
    try {
      const m = await this.conn.request<{ type: "proto.sessions"; sessions: SessionSummary[] }>({
        type: "proto.listSessions",
      });
      this.sessions = m.sessions;
      this.emit();
    } catch (e) {
      this.setError(String(e));
    }
  }

  async refreshModels(): Promise<void> {
    try {
      const m = await this.conn.request<{ type: "proto.models"; models: ModelInfo[] }>({
        type: "proto/listModels",
      });
      this.models = m.models;
      this.emit();
    } catch {
      /* no live session yet */
    }
  }

  async refreshRecentDirs(): Promise<void> {
    try {
      const m = await this.conn.request<{ type: "proto.recentDirs"; dirs: { path: string }[] }>({
        type: "proto/recentDirs",
      });
      this.recentDirs = m.dirs.map((d) => d.path);
      this.emit();
    } catch {
      /* not fatal */
    }
  }

  /**
   * Role names the live session's `/role` extension command offers as argument
   * completions (reserved words filtered out server-side). Requested fresh on
   * every picker open — names change when roles.json is hand-edited, and only
   * the extension knows the current set.
   */
  async roleNames(sessionId: string): Promise<string[]> {
    const m = await this.conn.request<{
      type: "proto.roleNames";
      sessionId: string;
      names: string[];
    }>({
      type: "proto.roleNames",
      sessionId,
    });
    return m.names ?? [];
  }

  async newSession(cwd: string, agentDir?: string): Promise<void> {
    const m = await this.conn.request<AttachedMsg>({ type: "proto.newSession", cwd, agentDir });
    await this.onAttached(m);
    await this.refreshSessions();
  }

  async openSession(sessionFile: string): Promise<void> {
    const m = await this.conn.request<AttachedMsg>({
      type: "proto.openSession",
      sessionFilePath: sessionFile,
    });
    await this.onAttached(m);
  }

  async attachTo(sessionId: string): Promise<void> {
    const m = await this.conn.request<AttachedMsg>({ type: "proto.attach", sessionId });
    await this.onAttached(m);
  }

  detach(sessionId: string): void {
    this.conn.sendFire({ type: "proto.detach", sessionId });
    this.attachedSessions.delete(sessionId);
    this.runStateById.delete(sessionId);
    this.liveEventsById.delete(sessionId);
    this.sentMessagesById.delete(sessionId);
    if (this.activeId === sessionId) {
      this.activeId = [...this.attachedSessions.keys()][0] ?? null;
    }
    this.emit();
  }

  /** Send a protocol command. Model picks echo locally for instant feedback. */
  cmd(m: C2S): void {
    if (m.type === "pi.setModel") {
      this.pendingModelById.set(m.sessionId, { provider: m.provider, modelId: m.modelId });
      this.emit();
    }
    this.conn.sendFire(m);
  }

  /** Send a prompt optimistically: the user's text appears immediately.
   *  If a run is already in flight the server queues it, so don't clobber the
   *  live run state (it stays streaming/tooling). */
  sendPrompt(sessionId: string, text: string): void {
    const run = this.stateOf(sessionId);
    if (run === "idle") this.runStateById.set(sessionId, "thinking");
    const sent = this.sentMessagesById.get(sessionId) ?? [];
    this.sentMessagesById.set(sessionId, [...sent, text]);
    this.emit();
    this.cmd({ type: "pi.prompt", sessionId, text });
  }

  /** Clear a transient error (after a UI surfaces it). */
  clearError(): void {
    if (this.error === null) return;
    this.error = null;
    this.emit();
  }

  /**
   * Remove a UI event once a frontend has presented it.
   *
   * Matched by `id`, never by object identity: a frontend hands back the object
   * it read from its own (usually reactive, proxy-wrapped) mirror, which is not
   * the object this store holds. Identity matching silently did nothing and the
   * event re-fired on every following change.
   */
  consumeUiEvent(event: UiEvent): void {
    const before = this.uiEvents.length;
    this.uiEvents = this.uiEvents.filter((e) => e.id !== event.id);
    if (this.uiEvents.length === before) return;
    this.emit();
  }

  /** Resolve an extension dialog/select request; also dequeues the request by id. */
  respondUi(
    req:
      | { kind: "select"; sessionId: string; selectId: string }
      | { kind: "dialog"; sessionId: string; dialogId: string },
    value: unknown,
  ): void {
    if (req.kind === "select") {
      this.cmd({
        type: "ui.selectResponse",
        sessionId: req.sessionId,
        selectId: req.selectId,
        index: typeof value === "number" ? value : null,
      });
      this.uiEvents = this.uiEvents.filter(
        (e) => !(e.kind === "select" && e.selectId === req.selectId),
      );
    } else {
      this.cmd({
        type: "ui.dialogResponse",
        sessionId: req.sessionId,
        dialogId: req.dialogId,
        value,
      });
      this.uiEvents = this.uiEvents.filter(
        (e) => !(e.kind === "dialog" && e.dialogId === req.dialogId),
      );
    }
    this.emit();
  }

  /**
   * Resolve a `/s/<hash>` path to a session file and open it. Returns false when
   * nothing matches, so the frontend can fall back to its default view.
   */
  async openPath(pathname: string): Promise<boolean> {
    const hash = hashFromPath(pathname);
    if (!hash) return false;
    await this.refreshSessions();
    const hit = this.sessions.find((s) => hash8(s.sessionFile) === hash);
    if (!hit) return false;
    await this.openSession(hit.sessionFile);
    return true;
  }

  // ------------------------------------------------------------ internals

  private async onConnect(): Promise<void> {
    void this.refreshRecentDirs();
    void this.refreshModels();
    await this.refreshSessions();
    this.emit();
    // let the frontend restore its view (e.g. the session named by the URL)
    await this.onReady(this);
  }

  private async onAttached(a: AttachedMsg): Promise<void> {
    const session: AttachedSession = { ...a, events: [] };
    this.attachedSessions.set(session.sessionId, session);
    this.liveEventsById.set(session.sessionId, []);
    this.sentMessagesById.set(session.sessionId, []);
    this.runStateById.set(session.sessionId, session.isStreaming ? "streaming" : "idle");
    this.activeId = session.sessionId;
    void this.refreshModels();
    this.emit();
    await this.refreshSessions();
  }

  private setError(message: string): void {
    this.error = message;
    this.emit();
  }

  private handle(m: S2C): void {
    switch (m.type) {
      case "proto.sessionState": {
        const a = this.attachedSessions.get(m.sessionId);
        // replace (don't mutate): mirrors key off object identity
        if (a) {
          this.attachedSessions.set(m.sessionId, {
            ...a,
            model: m.model,
            thinkingLevel: m.thinkingLevel,
            tools: m.tools,
            role: m.role,
            commands: m.commands,
          });
        }
        this.pendingModelById.delete(m.sessionId);
        break;
      }
      case "proto.statuses": {
        const a = this.attachedSessions.get(m.sessionId);
        if (a) this.attachedSessions.set(m.sessionId, { ...a, statuses: m.statuses });
        break;
      }
      case "proto.queues": {
        const a = this.attachedSessions.get(m.sessionId);
        if (a) {
          this.attachedSessions.set(m.sessionId, {
            ...a,
            steering: m.steering,
            followUp: m.followUp,
          });
        }
        break;
      }
      case "proto.sessions": {
        this.sessions = m.sessions;
        break;
      }
      case "proto.error": {
        this.error = m.message;
        this.pendingModelById.clear();
        // failed prompt → back to idle so the UI doesn't hang
        if (this.activeId && this.stateOf(this.activeId) === "thinking") {
          this.runStateById.set(this.activeId, "idle");
        }
        break;
      }
      case "proto.attached": {
        const a = m as unknown as AttachedSession;
        a.events = [];
        this.attachedSessions.set(m.sessionId, a);
        this.liveEventsById.set(m.sessionId, []);
        this.sentMessagesById.set(m.sessionId, []);
        this.runStateById.set(m.sessionId, m.isStreaming ? "streaming" : "idle");
        break;
      }
      case "pi.evt": {
        const old = this.liveEventsById.get(m.sessionId) ?? [];
        this.liveEventsById.set(m.sessionId, [...old, m.event]);
        this.settleSentMessage(m.sessionId, m.event);
        this.applyRunEvent(m.sessionId, m.event);
        break;
      }
      case "ui.event": {
        this.uiEvents = [...this.uiEvents, m.event];
        break;
      }
      default:
        return;
    }
    this.emit();
  }

  /** Drop the optimistic user message once the authoritative echo arrives. */
  /** Drop one optimistic user message per authoritative echo (they arrive in
   *  order). Clearing the whole list would wipe still-queued prompts that the
   *  server has not delivered yet. */
  private settleSentMessage(sessionId: string, event: unknown): void {
    const e = event as { type?: string; message?: { role?: string } };
    if (e?.type !== "message_start" || e.message?.role !== "user") return;
    const sent = this.sentMessagesById.get(sessionId);
    if (sent && sent.length > 0) this.sentMessagesById.set(sessionId, sent.slice(1));
  }

  /** Drive run state and context usage from the pi event stream. */
  private applyRunEvent(sessionId: string, event: unknown): void {
    const e = event as { type?: string; assistantMessageEvent?: { type?: string } };
    if (!e?.type) return;
    switch (e.type) {
      case "agent_start":
        if (["idle", "thinking"].includes(this.stateOf(sessionId))) {
          this.runStateById.set(sessionId, "thinking");
        }
        break;
      case "message_update": {
        const ae = e.assistantMessageEvent?.type;
        if (ae === "thinking_delta" || ae === "thinking_start") {
          this.runStateById.set(sessionId, "thinking");
        } else if (ae === "text_delta" || ae === "tool_use_start") {
          if (this.stateOf(sessionId) !== "tooling") {
            this.runStateById.set(sessionId, "streaming");
          }
        }
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
        this.runStateById.set(sessionId, "tooling");
        break;
      case "agent_end":
      case "agent_settled":
      case "abort":
        this.runStateById.set(sessionId, "idle");
        break;
      case "message_end": {
        const msg = (event as { message?: { usage?: Record<string, number>; stopReason?: string } })
          .message;
        if (msg?.usage) {
          this.contextTokensById.set(
            sessionId,
            (msg.usage.input ?? 0) + (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0),
          );
        }
        // toolUse → the loop continues; don't flicker to idle
        this.runStateById.set(sessionId, msg?.stopReason === "toolUse" ? "tooling" : "idle");
        break;
      }
      default:
        break;
    }
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a broken listener must not break the store */
      }
    }
  }
}
