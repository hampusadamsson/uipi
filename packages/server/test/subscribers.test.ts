// Regression test: a closed socket must be forgotten by every live session,
// otherwise dead subscribers accumulate and pi events fan out to closed sockets.
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";

type Live = { subscribers: Map<Subscriber, true> };

function fakeLive(): Live {
  return { subscribers: new Map() };
}

/** reach into the service's private map without a real pi runtime */
function seedLive(svc: SessionService, id: string, live: Live): void {
  (svc as unknown as { live: Map<string, Live> }).live.set(id, live);
}

describe("subscriber lifecycle", () => {
  it("dropSubscriber removes the socket from every live session", () => {
    const svc = new SessionService(undefined as never);
    const a = fakeLive();
    const b = fakeLive();
    seedLive(svc, "one", a);
    seedLive(svc, "two", b);

    const sub: Subscriber = { send: () => {} };
    a.subscribers.set(sub, true);
    b.subscribers.set(sub, true);
    expect(a.subscribers.size).toBe(1);
    expect(b.subscribers.size).toBe(1);

    svc.dropSubscriber(sub);

    expect(a.subscribers.has(sub)).toBe(false);
    expect(b.subscribers.has(sub)).toBe(false);
  });

  it("dropSubscriber leaves other subscribers attached", () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive();
    seedLive(svc, "one", live);

    const gone: Subscriber = { send: () => {} };
    const stays: Subscriber = { send: () => {} };
    live.subscribers.set(gone, true);
    live.subscribers.set(stays, true);

    svc.dropSubscriber(gone);

    expect(live.subscribers.has(gone)).toBe(false);
    expect(live.subscribers.has(stays)).toBe(true);
  });

  it("dropSubscriber on an unknown subscriber is a no-op", () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive();
    seedLive(svc, "one", live);
    const sub: Subscriber = { send: () => {} };
    expect(() => svc.dropSubscriber(sub)).not.toThrow();
    expect(live.subscribers.size).toBe(0);
  });
});
