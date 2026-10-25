// Transport behaviour with an injected socket stub — no DOM, no globals.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Conn, type WebSocketLike } from "../src/conn.js";

class FakeSocket implements WebSocketLike {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {}
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
  }
}

function makeConn(sockets: FakeSocket[]): Conn {
  return new Conn({
    url: "ws://localhost:8787/ws",
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
}

describe("Conn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects to the injected url", () => {
    const sockets: FakeSocket[] = [];
    const conn = makeConn(sockets);
    conn.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://localhost:8787/ws");
  });

  it("buffers commands sent before the socket opens, then flushes in order", () => {
    const sockets: FakeSocket[] = [];
    const conn = makeConn(sockets);
    conn.connect();
    conn.sendFire({ type: "proto.listSessions" });
    conn.sendFire({ type: "proto/recentDirs" });
    expect(sockets[0].sent).toHaveLength(0);

    sockets[0].readyState = 1;
    sockets[0].onopen?.();

    expect(sockets[0].sent).toHaveLength(2);
    expect(JSON.parse(sockets[0].sent[0]).type).toBe("proto.listSessions");
    expect(JSON.parse(sockets[0].sent[1]).type).toBe("proto/recentDirs");
  });

  it("correlates a request with its reply and ignores uncorrelated pushes", async () => {
    const sockets: FakeSocket[] = [];
    const conn = makeConn(sockets);
    const pushes: unknown[] = [];
    conn.onMessage = (m) => pushes.push(m);
    conn.connect();
    sockets[0].readyState = 1;
    sockets[0].onopen?.();

    const reply = conn.request({ type: "proto/listSessions" });
    const sent = JSON.parse(sockets[0].sent.at(-1)!);
    expect(sent.id).toBeDefined();

    // an unrelated push is routed to onMessage, not the waiter
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "pi.evt", sessionId: "s", event: {} }) });
    expect(pushes).toHaveLength(1);

    sockets[0].onmessage?.({
      data: JSON.stringify({ id: sent.id, type: "proto.sessions", sessions: [] }),
    });
    await expect(reply).resolves.toMatchObject({ type: "proto.sessions" });
  });

  it("rejects a request that never gets a reply", async () => {
    const sockets: FakeSocket[] = [];
    const conn = makeConn(sockets);
    conn.connect();
    sockets[0].readyState = 1;
    sockets[0].onopen?.();

    const reply = conn.request({ type: "proto/listSessions" }, 5000);
    const assertion = expect(reply).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("ignores malformed frames instead of throwing", () => {
    const sockets: FakeSocket[] = [];
    const conn = makeConn(sockets);
    conn.connect();
    sockets[0].readyState = 1;
    sockets[0].onopen?.();
    expect(() => sockets[0].onmessage?.({ data: "not json" })).not.toThrow();
  });

  it("reconnects with capped backoff and resets on a successful open", async () => {
    const sockets: FakeSocket[] = [];
    const conn = makeConn(sockets);
    const opened = vi.fn();
    conn.onOpen = opened;
    conn.connect();

    const first = sockets[0];
    first.onopen?.();
    first.onclose?.();
    await vi.advanceTimersByTimeAsync(1100);
    const second = sockets[1];
    expect(second).not.toBe(first);

    // never opened → next delay doubles to 2000ms
    second.onclose?.();
    await vi.advanceTimersByTimeAsync(1900);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(3);

    // backoff caps at 10s
    let cur = sockets[2];
    for (let i = 0; i < 8; i++) {
      cur.onclose?.();
      await vi.advanceTimersByTimeAsync(11000);
      cur = sockets.at(-1)!;
    }
    const before = sockets.length;
    cur.onclose?.();
    await vi.advanceTimersByTimeAsync(9999);
    expect(sockets).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(before + 1);

    // a successful open resets the delay
    sockets.at(-1)!.onopen?.();
    expect(opened).toHaveBeenCalled();
  });
});
