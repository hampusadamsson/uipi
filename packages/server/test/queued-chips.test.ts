// Queued messages must show a chip while pending and clear once delivered.
//
// Two bugs this covers:
//  1. pi drains its queue as soon as an item is picked up, so reading the queue
//     back right after enqueueing returns [] — the UI never showed a chip.
//  2. nothing was broadcast when a queued message was actually delivered, so a
//     chip (if shown) would stay forever.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SessionService, type CreateRuntimeFn } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type QueuesFrame = { type: "proto.queues"; steering: unknown[]; followUp: unknown[] };

const queuesOf = (frames: S2C[]) =>
  frames.filter((m): m is S2C & QueuesFrame => m.type === "proto.queues");

/** A live session whose get*Messages() always reports an empty queue, matching
 *  pi's behaviour of draining immediately after an item is accepted. */
function fakeLive() {
  const delivered: string[] = [];
  const session = {
    isIdle: false,
    prompt: () => Promise.reject(new Error("busy")),
    steer: () => {},
    followUp: (t: string) => delivered.push(t),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    clearQueue: () => {},
  };
  return { id: "s1", session, delivered, subscribers: new Map<Subscriber, true>() };
}

function seed(svc: SessionService, live: ReturnType<typeof fakeLive>) {
  (svc as unknown as { live: Map<string, unknown> }).live.set(live.id, live);
}

/**
 * A fake AgentSession plus a runtime factory good enough for `materialize()`,
 * the real path `proto.newSession` takes. It records the pi event callback the
 * server registers, so a test can emit exactly what pi would emit.
 */
function fakeRuntime() {
  const queue = { steering: [] as string[], followUp: [] as string[] };
  let emit: ((event: unknown) => void) | undefined;
  const session = {
    isIdle: false,
    thinkingLevel: "medium",
    messages: [] as unknown[],
    model: { provider: "p", id: "m" },
    sessionManager: { getBranch: () => [] },
    getActiveToolNames: () => ["read"],
    prompt: () => Promise.reject(new Error("busy")),
    steer: (t: string) => queue.steering.push(t),
    followUp: (t: string) => queue.followUp.push(t),
    getSteeringMessages: () => queue.steering,
    getFollowUpMessages: () => queue.followUp,
    clearQueue: () => {
      queue.steering.length = 0;
      queue.followUp.length = 0;
    },
    bindExtensions: () => Promise.resolve(),
    subscribe: (cb: (event: unknown) => void) => {
      emit = cb;
      return () => {};
    },
  };
  return {
    queue,
    createRuntime: (() => Promise.resolve({ session })) as unknown as CreateRuntimeFn,
    emit: (event: unknown) => emit?.(event),
  };
}

function setup() {
  const svc = new SessionService(undefined as never);
  const live = fakeLive();
  seed(svc, live);
  // two connected clients, both recording what they are sent
  const sentA: S2C[] = [];
  const sentB: S2C[] = [];
  live.subscribers.set({ send: (m) => sentA.push(m) }, true);
  live.subscribers.set({ send: (m) => sentB.push(m) }, true);
  const queues = () => queuesOf(sentA);
  return { svc, live, sentA, sentB, queues };
}

describe("queued message chips", () => {
  it("shows the queued prompt even though pi's queue reads back empty", async () => {
    const { svc, live, queues } = setup();

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "queued text" } as never,
      () => {},
    );

    expect(live.delivered).toEqual(["queued text"]);
    const frames = queues();
    expect(frames).toHaveLength(1);
    expect(frames[0].followUp).toEqual(["queued text"]);
  });

  it("broadcasts to every subscriber, not just the sender", async () => {
    const { svc, sentA, sentB } = setup();
    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "x" } as never,
      () => {},
    );

    // both clients must receive the frame — the sender is not special
    const a = queuesOf(sentA);
    const b = queuesOf(sentB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual(a[0]);
    expect(b[0].followUp).toEqual(["x"]);
  });

  it("clears the chip when pi delivers the queued message as a user message", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "uipi-chips-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "uipi-chips-cwd-"));
    const pi = fakeRuntime();
    const svc = new SessionService(pi.createRuntime);
    const sent: S2C[] = [];
    const sub: Subscriber = { send: (m) => sent.push(m) };

    // the production path: newSession → materialize() registers the pi event hook
    await svc.handle({ type: "proto.newSession", cwd, agentDir }, (m) => sent.push(m), sub);
    const attached = sent.find((m) => m.type === "proto.attached") as
      { sessionId: string } | undefined;
    expect(attached).toBeDefined();
    const sessionId = attached!.sessionId;

    // busy agent → the prompt is queued and the chip shows
    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId, text: "queued text" } as never,
      () => {},
    );
    expect(queuesOf(sent).at(-1)?.followUp).toEqual(["queued text"]);

    // pi delivers it: the queue drains and a real user message starts, which is
    // the event the server's subscribe hook keys on
    pi.queue.followUp.length = 0;
    pi.emit({ type: "message_start", message: { role: "user" } });

    const frames = queuesOf(sent);
    expect(frames).toHaveLength(2);
    // queue now genuinely empty → UI drops the chip
    expect(frames.at(-1)!.followUp).toEqual([]);
    expect(frames.at(-1)!.steering).toEqual([]);
  });

  it("also reports steering separately", async () => {
    const { svc, queues } = setup();
    await svc.handleSessionCmd(
      { type: "pi.steer", sessionId: "s1", text: "redirect" } as never,
      () => {},
    );
    expect(queues()[0].steering).toEqual(["redirect"]);
    expect(queues()[0].followUp).toEqual([]);
  });
});
