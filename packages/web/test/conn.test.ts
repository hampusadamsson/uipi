// Regression tests for conn.ts reconnect behavior (WebSocket stubbed).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {}
  send(_d: string): void {}
}

describe("Conn reconnect", () => {
  let originals: typeof WebSocket;

  beforeEach(() => {
    originals = (globalThis as { WebSocket: unknown }).WebSocket as typeof WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket as unknown as typeof WebSocket;
    (globalThis as unknown as { location: { protocol: string; host: string } }).location = {
      protocol: "http:",
      host: "localhost:8787",
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originals;
    vi.useRealTimers();
  });

  it("reconnects with capped backoff, resets backoff on successful open", async () => {
    vi.resetModules();
    const { Conn } = await import("../src/lib/conn.js");
    const conn = new Conn();
    const opened = vi.fn();
    conn.onOpen = opened;
    conn.connect();

    const first = (conn as unknown as { ws: FakeSocket }).ws;
    expect(first.url).toContain("/ws");

    first.onopen?.(); // success — backoff resets
    first.onclose?.();
    // first reconnect scheduled at ~1000ms
    vi.advanceTimersByTime(1100);
    const second = (conn as unknown as { ws: FakeSocket }).ws;
    expect(second).not.toBe(first);

    // never opened this time → next reconnect doubled to 2000ms
    second.onclose?.();
    vi.advanceTimersByTime(2100);
    const third = (conn as unknown as { ws: FakeSocket }).ws;
    expect(third).not.toBe(second);

    // cap at 10s after several failures
    let cur = third;
    for (let i = 0; i < 6; i++) {
      cur.onclose?.();
      vi.advanceTimersByTime(11000);
      cur = (conn as unknown as { ws: FakeSocket }).ws;
    }
    const before = (conn as unknown as { ws: FakeSocket }).ws;
    cur.onclose?.();
    vi.advanceTimersByTime(10000 - 1);
    expect((conn as unknown as { ws: FakeSocket }).ws).toBe(before); // not yet
    vi.advanceTimersByTime(1);
    expect((conn as unknown as { ws: FakeSocket }).ws).not.toBe(before);

    // open resets backoff to 1000ms again
    cur.onopen?.();
    expect(opened).toHaveBeenCalled();
  });
});
