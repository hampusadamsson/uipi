import type { C2S, S2C } from "@uipi/protocol";

/**
 * The minimal WebSocket surface the client needs. Declared structurally so this
 * package stays free of DOM types: a browser passes the native `WebSocket`, a
 * Node/TUI frontend passes the `ws` package's socket, and tests pass a stub.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Opens a socket for a given URL. Injected so the transport stays platform-agnostic. */
export type SocketFactory = (url: string) => WebSocketLike;

/** WebSocket.OPEN, without referencing the DOM constant. */
export const SOCKET_OPEN = 1;

export interface ConnOptions {
  /** Full ws:// or wss:// URL, e.g. "ws://127.0.0.1:8787/ws". */
  url: string;
  /** Platform socket constructor — browser `WebSocket` or Node `ws`. */
  createSocket: SocketFactory;
  /** Base reconnect delay in ms (doubles up to maxRetryMs). Default 1000. */
  retryMs?: number;
  /** Reconnect backoff ceiling in ms. Default 10000. */
  maxRetryMs?: number;
  /** Per-request reply timeout in ms. Default 15000. */
  requestTimeoutMs?: number;
}

/**
 * Transport for the uipi protocol: request/response correlation plus a push
 * channel for server-initiated messages, with automatic capped-backoff reconnect.
 *
 * Completely UI-agnostic — no DOM, no framework, no globals.
 */
export class Conn {
  private ws: WebSocketLike | null = null;
  private nextId = 0;
  private pending: C2S[] = [];
  private waiters = new Map<string, (m: S2C) => void>();
  private retryMs: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly requestTimeoutMs: number;
  private readonly opts: ConnOptions;

  /** Server-initiated message (anything not correlated to a request). */
  onMessage: (m: S2C) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  constructor(opts: ConnOptions) {
    this.opts = opts;
    this.baseRetryMs = opts.retryMs ?? 1000;
    this.maxRetryMs = opts.maxRetryMs ?? 10000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
    this.retryMs = this.baseRetryMs;
  }

  connect(): void {
    const ws = this.opts.createSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = this.baseRetryMs;
      for (const m of this.pending) this.send(m);
      this.pending = [];
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg: S2C & { id?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.waiters.has(msg.id)) {
        const w = this.waiters.get(msg.id)!;
        this.waiters.delete(msg.id);
        w(msg);
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      this.onClose();
      // auto-reconnect with capped backoff until the server is back
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
    };
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  private send(m: C2S): void {
    if (this.ws?.readyState === SOCKET_OPEN) this.ws.send(JSON.stringify(m));
    else this.pending.push(m);
  }

  /** Send a command and resolve with its correlated reply. */
  request<T extends S2C>(m: C2S, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("timeout waiting for reply"));
      }, timeoutMs);
      this.waiters.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg as T);
      });
      this.send({ ...m, id } as unknown as C2S);
    });
  }

  /** Fire-and-forget command. */
  sendFire(m: C2S): void {
    this.send(m);
  }
}
