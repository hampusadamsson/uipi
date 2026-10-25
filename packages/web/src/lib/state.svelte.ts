import { SvelteMap } from "svelte/reactivity";
import {
  Conn,
  UipiClient,
  pathFor,
  hash8,
  hashFromPath,
  type AttachedSession,
  type RunState,
  type TranscriptEntry,
  type WebSocketLike,
  deriveTranscript,
} from "@uipi/client";
import type { C2S, ModelInfo, SessionSummary, UiEvent } from "@uipi/protocol";

export type { RunState, TranscriptEntry, AttachedSession };

/**
 * Svelte adapter over the UI-agnostic {@link UipiClient}.
 *
 * All protocol, reducer and command logic lives in `@uipi/client`; this class
 * only mirrors client state into Svelte reactivity (runes + SvelteMap) so
 * components re-render on change. A TUI would adapt the same client to its own
 * render loop instead — no protocol or reducer logic is duplicated there.
 */
export class UiState {
  readonly client: UipiClient;

  connected = $state(false);
  sessions = $state<SessionSummary[]>([]);
  recentDirs = $state<string[]>([]);
  models = $state<ModelInfo[]>([]);
  activeId = $state<string | null>(null);
  uiEvents = $state<UiEvent[]>([]);
  error = $state<string | null>(null);
  /** transient UI-only flag: the "new session" modal is open */
  wantNew = $state(false);

  attached = new SvelteMap<string, AttachedSession>();
  runState = new SvelteMap<string, RunState>();
  liveEvents = new SvelteMap<string, unknown[]>();
  sentMessages = new SvelteMap<string, string[]>();
  contextTokens = new SvelteMap<string, number>();
  pendingModel = new SvelteMap<string, { provider: string; modelId: string }>();

  constructor() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.client = new UipiClient(
      new Conn({
        url: `${proto}://${location.host}/ws`,
        createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
      }),
    );
    this.client.onChange(() => this.sync());
  }

  init() {
    window.addEventListener("popstate", () => void this.hydrateFromUrl());
    this.client.attach();
  }

  // ------------------------------------------------------- reads over client

  stateOf(id: string | null): RunState {
    return this.client.stateOf(id);
  }

  /** Optimistic model echo, else the attached model. */
  modelOf(sessionId: string | null): { provider: string; modelId: string } | null | undefined {
    return sessionId ? this.client.effectiveModel(sessionId) : undefined;
  }

  transcript(sessionId: string): TranscriptEntry[] {
    const attach = this.attached.get(sessionId);
    if (!attach) return [];
    return deriveTranscript({
      messages: attach.messages ?? [],
      events: this.liveEvents.get(sessionId) ?? [],
      sentMessages: this.sentMessages.get(sessionId) ?? [],
    });
  }

  // ------------------------------------------------------------- commands

  async refreshSessions() {
    await this.client.refreshSessions();
  }

  async refreshModels() {
    await this.client.refreshModels();
  }

  async newSession(cwd: string, agentDir?: string) {
    await this.client.newSession(cwd, agentDir);
    this.syncUrl();
  }

  async openSession(sessionFile: string) {
    await this.client.openSession(sessionFile);
    this.syncUrl();
  }

  async attach(sessionId: string) {
    await this.client.attachTo(sessionId);
    this.syncUrl();
  }

  detach(id: string) {
    this.client.detach(id);
    this.syncUrl();
  }

  cmd(m: C2S): void {
    this.client.cmd(m);
  }

  sendPrompt(sessionId: string, text: string): void {
    this.client.sendPrompt(sessionId, text);
  }

  /** Present and clear a UI event (extension dialog/select/notification). */
  consumeUiEvent(event: UiEvent): void {
    this.client.consumeUiEvent(event);
  }

  respondUi(
    req:
      | { kind: "select"; sessionId: string; selectId: string }
      | { kind: "dialog"; sessionId: string; dialogId: string },
    value: unknown,
  ): void {
    this.client.respondUi(req, value);
  }

  clearError(): void {
    this.client.clearError();
  }

  // ------------------------------------------------------------- url sync

  private syncUrl(): void {
    const url = this.client.activePath();
    if (location.pathname !== url) history.pushState(null, "", url);
  }

  /** Restore the session named by the current URL, if any. */
  async hydrateFromUrl(): Promise<void> {
    const opened = await this.client.openPath(location.pathname);
    if (opened) {
      this.syncUrl();
      return;
    }
    if (hashFromPath(location.pathname)) {
      // stale or not-yet-persisted session — land on the default view
      history.replaceState(null, "", "/");
    }
  }

  /** Exposed for tests / deep links: `/s/<hash>` for a session file. */
  static pathFor(sessionFile: string | null | undefined): string {
    return pathFor(sessionFile);
  }

  static hash8(path: string): string {
    return hash8(path);
  }

  // ------------------------------------------------ client → svelte mirror

  /** Mirror the framework-agnostic client state into Svelte reactivity. */
  private sync(): void {
    const c = this.client;
    this.connected = c.connected;
    this.sessions = c.sessions;
    this.recentDirs = c.recentDirs;
    this.models = c.models;
    this.activeId = c.activeId;
    this.uiEvents = [...c.getUiEvents()];
    this.error = c.error;

    for (const s of c.attachedSessionsList) this.attached.set(s.sessionId, s);
    for (const id of [...this.attached.keys()]) {
      if (!c.getAttached(id)) this.attached.delete(id);
    }
    for (const id of [...this.attached.keys()]) {
      this.runState.set(id, c.stateOf(id));
      this.liveEvents.set(id, c.liveEvents(id));
      this.sentMessages.set(id, c.sentMessages(id));
      const ctx = c.contextTokens(id);
      if (ctx !== undefined) this.contextTokens.set(id, ctx);
      const pm = c.pendingModel(id);
      if (pm) this.pendingModel.set(id, pm);
      else this.pendingModel.delete(id);
    }
  }
}

export const ui = new UiState();
