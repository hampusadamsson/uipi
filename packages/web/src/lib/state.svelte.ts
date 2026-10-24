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

export interface ChatMessage {
  role: string;
  removeTextBlock: false;
  content: unknown;
  raw: unknown;
  text: string;
}

// Re-declare for local use (protocol doesn't include Attachment yet)
export type Attach = Attachment;

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
      /* ignore before any session exists */
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
    this.attached.set(m.sessionId, m as unknown as Attachment);
    this.activeId = m.sessionId;
    void this.refreshModels();
    await this.refreshSessions();
  }

  detach(id: string) {
    this.conn.sendFire({ type: "proto.detach", sessionId: id });
    this.attached.delete(id);
    if (this.activeId === id) this.activeId = [...this.attached.keys()][0] ?? null;
  }

  cmd(m: C2S): void {
    this.conn.sendFire(m);
  }

  private handle(m: S2C): void {
    switch (m.type) {
      case "proto.sessions": {
        this.sessions = m.sessions;
        break;
      }
      case "proto.error": {
        this.error = m.message;
        setTimeout(() => (this.error = null), 6000);
        break;
      }
      case "proto.attached": {
        this.attached.set(m.sessionId, m as unknown as Attachment);
        break;
      }
      case "pi.evt": {
        const a = this.attached.get(m.sessionId);
        if (a) a.events.push(m.event);
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
}

export const ui = new UiState();
