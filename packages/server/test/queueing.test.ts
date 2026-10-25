// Sending a prompt while the agent is busy must queue it, never fail.
//
// Regression: the server called session.prompt() unconditionally, and pi throws
// "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')"
// when a run is in flight. Users lost the message.
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type Sent = S2C[];

/** A fake live session with a controllable busy flag and queue. */
function fakeLive(opts: { idle: boolean }) {
  const queues = { steering: [] as string[], followUp: [] as string[] };
  const prompts: string[] = [];
  const session = {
    get isIdle() {
      return opts.idle;
    },
    prompt: (text: string) => {
      if (!opts.idle) {
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
      }
      prompts.push(text);
      return Promise.resolve();
    },
    steer: (text: string) => queues.steering.push(text),
    followUp: (text: string) => queues.followUp.push(text),
    getSteeringMessages: () => queues.steering,
    getFollowUpMessages: () => queues.followUp,
    clearQueue: () => {
      queues.steering.length = 0;
      queues.followUp.length = 0;
    },
  };
  return { id: "s1", session, prompts, queues };
}

function seed(svc: SessionService, live: ReturnType<typeof fakeLive>, sub: Subscriber) {
  const map = (svc as unknown as { live: Map<string, unknown> }).live;
  map.set(live.id, live);
  live.subscribers = new Map([[sub, true]]);
}

describe("pi.prompt queueing", () => {
  it("queues as a follow-up when the agent is busy instead of erroring", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive({ idle: false });
    const sent: Sent = [];
    const sub: Subscriber = { send: (m) => sent.push(m) };
    seed(svc, live, sub);

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "second message" } as never,
      (m) => sent.push(m),
    );

    expect(live.queues.followUp).toEqual(["second message"]);
    expect(live.prompts).toEqual([]);
    // no error frame
    expect(sent.filter((m) => m.type === "proto.error")).toHaveLength(0);
  });

  it("broadcasts queue contents so the UI can show the pending chip", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive({ idle: false });
    const sent: Sent = [];
    const sub: Subscriber = { send: (m) => sent.push(m) };
    seed(svc, live, sub);

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "queued!" } as never,
      (m) => sent.push(m),
    );

    const q = sent.find((m) => m.type === "proto.queues") as
      { steering: unknown[]; followUp: string[] } | undefined;
    expect(q).toBeDefined();
    expect(q!.followUp).toEqual(["queued!"]);
    expect(q!.steering).toEqual([]);
  });

  it("prompts directly when idle", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive({ idle: true });
    const sub: Subscriber = { send: () => {} };
    seed(svc, live, sub);

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "go" } as never,
      () => {},
    );

    expect(live.prompts).toEqual(["go"]);
    expect(live.queues.followUp).toEqual([]);
  });

  it("broadcasts queues after a steer/followUp/cancel too", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive({ idle: false });
    const sent: Sent = [];
    const sub: Subscriber = { send: (m) => sent.push(m) };
    seed(svc, live, sub);

    await svc.handleSessionCmd(
      { type: "pi.steer", sessionId: "s1", text: "redirect" } as never,
      (m) => sent.push(m),
    );
    expect(sent.some((m) => m.type === "proto.queues")).toBe(true);
    expect(live.queues.steering).toEqual(["redirect"]);
  });
});
