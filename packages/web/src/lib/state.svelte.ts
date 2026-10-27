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
import { renderMarkdown } from "./markdown.js";
import type { C2S, ModelInfo, SessionSummary, UiEvent, UiNotification } from "@uipi/protocol";

export type { RunState, TranscriptEntry, AttachedSession };

/**
 * True when the adapter's mirror already reflects `events`.
 *
 * Compared by length *and* ids: a bare length check misses a same-length change
 * (one notification consumed while another arrived in the same sync), and the
 * stale copy then re-presents an event the client already drained.
 */
function sameUiEvents(a: readonly UiEvent[], b: readonly UiEvent[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => e === b[i] || e.id === b[i].id);
}

/**
 * Notifications the web UI drops instead of toasting.
 *
 * Suppression keys off the server-assigned `origin` tag, not the message text:
 * the extension owns the wording (and appends warning suffixes), and the server
 * is the only place that knows a notification was caused by a uipi command. A
 * status slot can't stand in for it — statuses mirror *state* (the active role)
 * and are
 * broadcast on their own schedule, so they say nothing about which notification
 * frames belong to the confirmation. The header chip already shows the role, so
 * `setRole` confirmations are pure noise here; anything an extension raises on
 * its own initiative (refusals, `/role keys`, config diagnostics) keeps toasting.
 */
export function isQuietNotification(e: UiEvent): boolean {
  // Errors and warnings always survive: they carry facts the chip cannot show
  // ("agent busy", "no API key for the role's model"). Only the clean
  // confirmation of a switch we initiated is noise.
  return e.kind === "notification" && e.origin === "setRole" && e.level === "info";
}

/**
 * Sidebar badge text for a session: the role name, or null when roleless.
 * Reads `SessionSummary.role`, so it works for sessions the server has never
 * materialized (archived rows) as well as live ones.
 */
export function sessionRoleText(s: SessionSummary): string | null {
  const role = s.role;
  return typeof role === "string" && role.trim() !== "" ? role : null;
}

/**
 * One row of the role picker: a role name, or one of the two affordances the
 * picker owns (`(none)` to clear, reload to re-read roles.json).
 *
 * `current` marks the row that matches the session's active role so the picker
 * can show where you are; it is display-only (no drift indicator, and no lock:
 * model/thinking overrides leave it alone).
 */
export type RolePickerItem =
  | { kind: "role"; label: string; role: string; current: boolean }
  | { kind: "none"; label: string; role: null; current: boolean }
  | { kind: "reload"; label: string; role: string | null; current: false };

/**
 * Picker rows for a freshly fetched name list plus the active role.
 *
 * Names come from `/role`'s own argument completions, so they already include
 * hidden roles (completions can't tell them apart). The server filtered the
 * extension's reserved words, so anything here is a real role name. Duplicates
 * are dropped defensively; order is the extension's (roles.json order), which is
 * the order the TUI shows them in.
 */
export function rolePickerItems(names: string[], current: string | null): RolePickerItem[] {
  const items: RolePickerItem[] = [];
  const seen: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0 || seen.includes(name)) continue;
    seen.push(name);
    items.push({ kind: "role", label: name, role: name, current: name === current });
  }
  items.push({ kind: "none", label: "(none)", role: null, current: current === null });
  items.push({
    kind: "reload",
    label: `reload roles.json, keep “${current ?? "none"}”`,
    role: current,
    current: false,
  });
  return items;
}

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
    // restore the session named by the URL on first connect and every reconnect
    this.client.onReady = async () => {
      await this.hydrateFromUrl();
      this.syncUrl();
    };
  }

  init() {
    window.addEventListener("popstate", () => void this.hydrateFromUrl());
    this.client.attach();
  }

  // ------------------------------------------------------- reads over client
  // NOTE: these must read the reactive mirrors below (SvelteMap / $state), not
  // `this.client` — the client is a plain object, so anything derived from it
  // would never invalidate. `sync()` is what pushes client state into these.

  stateOf(id: string | null): RunState {
    if (!id) return "idle";
    return this.runState.get(id) ?? "idle";
  }

  /** Optimistic model echo, else the attached model. */
  modelOf(sessionId: string | null): { provider: string; modelId: string } | null | undefined {
    if (!sessionId) return undefined;
    return (
      this.pendingModel.get(sessionId) ??
      (this.attached.get(sessionId)?.model as { provider: string; modelId: string } | null) ??
      undefined
    );
  }

  /** Active role of an attached session, or null when roleless. */
  roleOf(sessionId: string | null): string | null {
    if (!sessionId) return null;
    const role = this.attached.get(sessionId)?.role;
    return typeof role === "string" && role.trim() !== "" ? role : null;
  }

  /** Discoverable slash commands (extension, prompt templates, skills) of a session. */
  commandsOf(sessionId: string | null): { name: string; description?: string }[] {
    if (!sessionId) return [];
    return this.attached.get(sessionId)?.commands ?? [];
  }

  /**
   * Slash-command autocomplete items: every discovered command with a leading
   * "/", plus the two the web UI itself implements (`/new`, `/compact`). Skill
   * and prompt-template entries pass through untouched — no role filtering.
   */
  slashItems(sessionId: string | null): string[] {
    const discovered = this.commandsOf(sessionId).map((c) => `/${c.name}`);
    // `/new` is intercepted client-side, `/compact` maps to pi.compact: neither
    // is a registered extension command, so the server cannot advertise them.
    const all = [...discovered, "/compact", "/new"];
    return all.filter((name, i) => all.indexOf(name) === i).sort();
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

  /**
   * HTML body for a transcript entry, or null when it should render as plain
   * text. Only what the *agent* wrote is markdown: the user's own message is
   * echoed back verbatim so it always looks exactly as typed, and system rows
   * (role switches, compaction) are single generated lines, not prose.
   */
  entryHtml(entry: TranscriptEntry): string | null {
    if (entry.kind !== "message" || entry.role !== "assistant" || entry.text.length === 0) {
      return null;
    }
    return renderMarkdown(entry.text);
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

  /**
   * Role names for the picker, read fresh from the live session's `/role`
   * argument completions. Deliberately not mirrored into reactive state: names
   * can change under a hand-edited roles.json, so every picker open asks again.
   */
  roleNames(sessionId: string): Promise<string[]> {
    return this.client.roleNames(sessionId);
  }

  sendPrompt(sessionId: string, text: string): void {
    this.client.sendPrompt(sessionId, text);
  }

  /** Present and clear a UI event (extension dialog/select/notification). */
  consumeUiEvent(event: UiEvent): void {
    this.client.consumeUiEvent(event);
  }

  /**
   * Present and drain the oldest queued notification.
   *
   * Returns false when the queue holds none. The caller supplies `present` so the
   * adapter stays UI-agnostic (the web app toasts, a TUI would paint a line), and
   * lives here rather than in the component so the drain contract — exactly once, and
   * quiet ones silently — is testable without mounting Svelte.
   */
  drainNotification(present: (e: UiNotification) => void): boolean {
    const notif = this.uiEvents.find((e) => e.kind === "notification");
    if (!notif || notif.kind !== "notification") return false;
    if (isQuietNotification(notif)) {
      this.consumeUiEvent(notif);
      return true;
    }
    present(notif);
    this.consumeUiEvent(notif);
    return true;
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
    const events = c.getUiEvents();
    // keep the existing array when nothing changed so consumers' $effects don't
    // re-run on every unrelated sync (notifications are drained by id)
    if (!sameUiEvents(events, this.uiEvents)) this.uiEvents = [...events];
    this.error = c.error;

    for (const s of c.attachedSessionsList) this.attached.set(s.sessionId, s);
    for (const id of [...this.attached.keys()]) {
      if (!c.getAttached(id)) this.attached.delete(id);
    }
    for (const id of [...this.attached.keys()]) {
      this.runState.set(id, c.stateOf(id));
      // only replace when the reference actually changed, so a sync caused by
      // one session doesn't invalidate every other session's transcript
      const live = c.liveEvents(id);
      if (this.liveEvents.get(id) !== live) this.liveEvents.set(id, live);
      const sent = c.sentMessages(id);
      if (this.sentMessages.get(id) !== sent) this.sentMessages.set(id, sent);
      const ctx = c.contextTokens(id);
      if (ctx !== undefined) this.contextTokens.set(id, ctx);
      const pm = c.pendingModel(id);
      if (pm) this.pendingModel.set(id, pm);
      else this.pendingModel.delete(id);
    }
  }
}

export const ui = new UiState();
