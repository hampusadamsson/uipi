import { SvelteMap } from "svelte/reactivity";
import { Conn } from "./conn.js";
import type {
  Attachment,
  C2S,
  ModelInfo,
  SessionSummary,
  S2C,
  UiEvent,
} from "@uipi/protocol";

export type RunState = "idle" | "thinking" | "streaming" | "tooling";

/** Minimal global app state via runes-compatible class. */
export class UiState {
  conn = new Conn();
  connected = $state(false);
  sessions = $state<SessionSummary[]>([]);
  recentDirs = $state<string[]>([]);
  models = $state<ModelInfo[]>([]);
  /** sessionId -> attachment */
  attached = new SvelteMap<string, Attachment>();
  activeId = $state<string | null>(null);
  uiEvents = $state<UiEvent[]>([]);
  error = $state<string | null>(null);
  wantNew = $state(false);
  /** sessionId -> live run state */
  runState = new SvelteMap<string, RunState>();
  /** sessionId -> live pi events (reactive; pushes trigger rerenders) */
  liveEvents = new SvelteMap<string, unknown[]>();
  /** sessionId -> user messages sent locally (reactive; shown instantly) */
  sentMessages = new SvelteMap<string, string[]>();
  /** sessionId -> latest context tokens (input+cacheRead+cacheWrite from message_end) */
  contextTokens = new SvelteMap<string, number>();
  /** sessionId -> model pick echoed locally before proto.modelSet settles */
  pendingModel = new SvelteMap<string, { provider: string; modelId: string }>();

  init() {
    this.conn.onOpen = () => {
      this.connected = true;
      void this.refreshSessions();
      void this.conn
        .request<S2C & { dirs: { path: string }[] }>({ type: "proto/recentDirs" })
        .then((m) => (this.recentDirs = m.dirs.map((d) => d.path)))
        .catch(() => {});
      void this.refreshModels();
    };
    this.conn.onClose = () => {
      this.connected = false;
    };
    this.conn.onMessage = (m) => this.handle(m);
    this.conn.connect();
  }

  stateOf(id: string | null): RunState {
    if (!id) return "idle";
    return this.runState.get(id) ?? "idle";
  }

  async refreshSessions() {
    try {
      const m = await this.conn.request<S2C & { sessions: SessionSummary[] }>({
        type: "proto.listSessions",
      });
      this.sessions = m.sessions;
    } catch (e) {
      this.error = String(e);
    }
  }

  async refreshModels() {
    try {
      const m = await this.conn.request<S2C & { models: ModelInfo[] }>({
        type: "proto/listModels",
      });
      this.models = m.models;
    } catch {
      /* no live session yet */
    }
  }

  async newSession(cwd: string, agentDir?: string) {
    const m = await this.conn.request<
      S2C & { type: "proto.attached"; sessionId: string }
    >({ type: "proto.newSession", cwd, agentDir });
    await this.onAttached(m);
    await this.refreshSessions();
  }

  async openSession(sessionFile: string) {
    const m = await this.conn.request<
      S2C & { type: "proto.attached"; sessionId: string }
    >({ type: "proto.openSession", sessionFilePath: sessionFile });
    await this.onAttached(m);
  }

  async attach(sessionId: string) {
    const m = await this.conn.request<
      S2C & { type: "proto.attached"; sessionId: string }
    >({ type: "proto.attach", sessionId });
    await this.onAttached(m);
  }

  private async onAttached(m: S2C & { type: "proto.attached" }) {
    const a = m as unknown as Attachment;
    a.events = [];
    this.attached.set(m.sessionId, a);
    this.liveEvents.set(m.sessionId, []);
    this.sentMessages.set(m.sessionId, []);
    this.runState.set(m.sessionId, m.isStreaming ? "streaming" : "idle");
    this.activeId = m.sessionId;
    void this.refreshModels();
    await this.refreshSessions();
  }

  detach(id: string) {
    this.conn.sendFire({ type: "proto.detach", sessionId: id });
    this.attached.delete(id);
    this.runState.delete(id);
    this.liveEvents.delete(id);
    this.sentMessages.delete(id);
    if (this.activeId === id) this.activeId = [...this.attached.keys()][0] ?? null;
  }

  cmd(m: C2S): void {
    // optimistic echo for model picks so the UI updates instantly
    if (m.type === "pi.setModel") {
      this.pendingModel.set(m.sessionId, { provider: m.provider, modelId: m.modelId });
    }
    this.conn.sendFire(m);
  }

  /** optimistic send: set pending state right away, server events will settle it */
  sendPrompt(sessionId: string, text: string): void {
    this.runState.set(sessionId, "thinking");
    const sent = this.sentMessages.get(sessionId) ?? [];
    this.sentMessages.set(sessionId, [...sent, text]);
    this.cmd({ type: "pi.prompt", sessionId, text });
  }

  private handle(m: S2C): void {
    switch (m.type) {
      case "proto.modelSet": {
        const a = this.attached.get(m.sessionId);
        if (a) (a as { model?: unknown }).model = m.model;
        this.pendingModel.delete(m.sessionId);
        break;
      }
      case "proto.sessions": {
        this.sessions = m.sessions;
        break;
      }
      case "proto.error": {
        this.error = m.message;
        // failed prompt → back to idle so UI doesn't hang; failed model pick → revert echo
        this.pendingModel.clear();
        if (this.activeId && this.stateOf(this.activeId) === "thinking") {
          this.runState.set(this.activeId, "idle");
        }
        break;
      }
      case "proto.attached": {
        const a = m as unknown as Attachment;
        a.events = [];
        this.attached.set(m.sessionId, a);
        this.liveEvents.set(m.sessionId, []);
        this.sentMessages.set(m.sessionId, []);
        this.runState.set(m.sessionId, m.isStreaming ? "streaming" : "idle");
        break;
      }
      case "pi.evt": {
        // REACTIVE: replace the array (mutation of a plain array is invisible
        // to Svelte 5 — only Map.set triggers)
        const old = this.liveEvents.get(m.sessionId) ?? [];
        this.liveEvents.set(m.sessionId, [...old, m.event]);
        // once the authoritative user echo arrives, drop the optimistic copy
        if ((m.event as { type?: string })?.type === "message_start") {
          const role = (m.event as { message?: { role?: string } }).message?.role;
          if (role === "user") {
            const sent = this.sentMessages.get(m.sessionId);
            if (sent && sent.length > 0) this.sentMessages.set(m.sessionId, []);
          }
        }
        this.applyRunEvent(m.sessionId, m.event);
        break;
      }
      case "ui.event": {
        this.uiEvents = [...this.uiEvents, m.event];
        break;
      }
      default:
        break;
    }
  }

  /** drive runState from the pi event stream */
  private applyRunEvent(sessionId: string, ev: unknown): void {
    const e = ev as { type?: string; assistantMessageEvent?: { type?: string } };
    if (!e?.type) return;
    switch (e.type) {
      case "agent_start":
        // first event of a run — only upgrade from idle/thinking
        if (["idle", "thinking"].includes(this.stateOf(sessionId))) {
          this.runState.set(sessionId, "thinking");
        }
        break;
      case "message_update": {
        const ae = e.assistantMessageEvent?.type;
        if (ae === "thinking_delta" || ae === "thinking_start") {
          this.runState.set(sessionId, "thinking");
        } else if (ae === "text_delta" || ae === "tool_use_start") {
          if (this.stateOf(sessionId) !== "tooling") this.runState.set(sessionId, "streaming");
        }
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
        this.runState.set(sessionId, "tooling");
        break;
      case "agent_end":
      case "agent_settled":
      case "abort":
        this.runState.set(sessionId, "idle");
        break;
      case "message_end": {
        // context usage ≈ input + cacheRead + cacheWrite of latest assistant msg
        const msg = (ev as { message?: { usage?: Record<string, number>; stopReason?: string } }).message;
        if (msg?.usage) {
          this.contextTokens.set(
            sessionId,
            (msg.usage.input ?? 0) +
              (msg.usage.cacheRead ?? 0) +
              (msg.usage.cacheWrite ?? 0)
          );
        }
        // toolUse → agent loop continues; don't flicker to idle
        if (msg?.stopReason === "toolUse") {
          this.runState.set(sessionId, "tooling");
        } else {
          this.runState.set(sessionId, "idle");
        }
        break;
      }
      default:
        break;
    }
  }
}

export const ui = new UiState();
