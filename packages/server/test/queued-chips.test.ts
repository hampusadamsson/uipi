// Queued messages must show a chip while pending and clear once delivered.
//
// Two bugs this covers:
//  1. pi drains its queue as soon as an item is picked up, so reading the queue
//     back right after enqueueing returns [] — the UI never showed a chip.
//  2. nothing was broadcast when a queued message was actually delivered, so a
//     chip (if shown) would stay forever.
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type QueuesFrame = { type: "proto.queues"; steering: unknown[]; followUp: unknown[] };

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

function setup() {
  const svc = new SessionService(undefined as never);
  const live = fakeLive();
  seed(svc, live);
  const sent: S2C[] = [];
  // two connected clients
  live.subscribers.set({ send: (m) => sent.push(m) }, true);
  live.subscribers.set({ send: () => {} }, true);
  const queues = () => sent.filter((m): m is S2C & QueuesFrame => m.type === "proto.queues");
  return { svc, live, sent, queues };
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
    const { svc, sent } = setup();
    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "x" } as never,
      () => {},
    );
    // sent[] only records the first subscriber, but broadcastQueues sends to all
    expect(sent.filter((m) => m.type === "proto.queues")).toHaveLength(1);
  });

  it("clears the chip when the queued message is delivered", () => {
    const { live, sent } = setup();
    // the chip is currently showing (delivered list non-empty conceptually);
    // simulate pi delivering it as a real user message
    const svc = new SessionService(undefined as never);
    const l = fakeLive();
    seed(svc, l);
    l.subscribers.set({ send: (m) => sent.push(m) }, true);

    // this is what the subscribe handler does on a user message_start
    svc["broadcastQueues"](l as never);

    const frames = sent.filter((m) => m.type === "proto.queues") as (S2C & QueuesFrame)[];
    expect(frames).toHaveLength(1);
    // queue now genuinely empty → UI drops the chip
    expect(frames[0].followUp).toEqual([]);
    expect(frames[0].steering).toEqual([]);
    void live;
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
