import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { S2C, UiEvent } from "@uipi/protocol";
import type { Send } from "./types.js";

/**
 * A no-op terminal theme. Web mode has no ANSI color, so every style helper
 * returns its text verbatim. Extensions that decorate text (e.g.
 * `ctx.ui.theme.fg("accent", ...)`) keep working instead of throwing.
 *
 * Two shapes are used by pi's Theme: token styles take `(token, text)` —
 * fg/bg — and attribute styles take `(text)` — bold/italic/underline/etc.
 */
const plainTheme = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === "appearance") return "dark";
      if (prop === "colors") return {};
      if (prop === "fg" || prop === "bg" || prop === "token") {
        return (_token?: unknown, text?: unknown) => (typeof text === "string" ? text : "");
      }
      return (text?: unknown) => (typeof text === "string" ? text : "");
    },
  },
) as ExtensionUIContext["theme"];

/**
 * Web-mode ExtensionUIContext host: bridges pi extension `ctx.ui` calls
 * (select/confirm/input/notify) over the WS protocol to browser UI and
 * routes `ui.dialogResponse`/`ui.selectResponse` commands back into the
 * pending promises.
 */
export class UiHost {
  private pending = new Map<string, (v: unknown) => void>();
  private nextId = 1;
  private send: Send = () => {};
  /**
   * Status slots set by extensions via `ctx.ui.setStatus(key, text)` — the same
   * footer slots the TUI renders. Mirrored to clients as `proto.statuses`.
   */
  private statuses = new Map<string, string>();

  constructor(
    private sessionId: () => string,
    private mode = "rpc",
  ) {}

  /** wire to the WS subscriber with implicit-attach semantics */
  attachSend(send: Send): void {
    this.send = send;
  }

  /** incoming ui.dialogResponse / ui.selectResponse from a client */
  response(kind: "dialog" | "select", id: string, value: unknown): void {
    const res = this.pending.get(id);
    if (res) {
      this.pending.delete(id);
      res(value);
    }
  }

  ui: ExtensionUIContext = {
    select: (title, options, opts) => this.request("select", { title, options, opts }),
    confirm: (title, message, opts) => this.request("confirm", { title, message, opts }),
    input: (title, placeholder, opts) => this.request("input", { title, placeholder, opts }),
    notify: (message, type = "info") => {
      const ev: UiEvent = {
        kind: "notification",
        sessionId: this.sessionId(),
        level: type === "warning" ? "warn" : type === "error" ? "error" : "info",
        message,
      };
      this.send({ type: "ui.event", event: ev } as unknown as S2C);
    },
    // terminal-only bits: no-ops in web mode
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      const prev = this.statuses.get(key);
      // undefined clears the slot; an unchanged value is not worth a broadcast
      if (text === undefined) {
        if (prev === undefined) return;
        this.statuses.delete(key);
      } else {
        if (prev === text) return;
        this.statuses.set(key, text);
      }
      this.emitStatuses();
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>(): Promise<T> => {
      throw new Error("ui.custom is not available in web mode");
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: (_title, prefill) => Promise.resolve(prefill),
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    // Extensions call ctx.ui.theme.fg(...) to style terminal text. In web mode
    // there are no ANSI colors: return the text unchanged so extensions that
    // decorate status/notifications don't crash.
    theme: plainTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "themes not available in web mode" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as ExtensionUIContext;

  /** Broadcast every status slot after a change — the map is replaced wholesale */
  private emitStatuses(): void {
    const statuses: Record<string, string> = {};
    for (const [key, text] of this.statuses) statuses[key] = text;
    this.send({ type: "proto.statuses", sessionId: this.sessionId(), statuses });
  }

  /** Protocol surface the client sees (mirrors @uipi/protocol UiEvent kinds) */
  private request<T>(
    kind: "select" | "confirm" | "input",
    payload: unknown,
  ): Promise<T | undefined> {
    const id = `ui${this.nextId++}`;
    return new Promise((resolve) => {
      // tie-breaker so a closed browser doesn't hang the extension forever
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined as T | undefined);
      }, 120000);
      this.pending.set(id, (v: unknown) => {
        clearTimeout(t);
        resolve(v as T);
      });
      const ev: UiEvent =
        kind === "select"
          ? {
              kind: "select",
              selectId: id,
              sessionId: this.sessionId(),
              title: (payload as { title: string }).title,
              options: ((payload as { options: string[] }).options ?? []).map((label) => ({
                label,
              })),
            }
          : {
              kind: "dialog",
              dialogId: id,
              sessionId: this.sessionId(),
              title: (payload as { title: string }).title,
              payload,
            };
      this.send({ type: "ui.event", event: ev } as unknown as S2C);
    });
  }
}
