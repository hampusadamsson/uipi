// Thinking level: the request must reach the session, and the UI must show what
// the session actually has.
//
// Two bugs this pins:
//
//  1. `pi.setThinkingLevel` applied the level and broadcast nothing, so the
//     picker kept rendering the old value until some unrelated event refreshed
//     it. A setting you cannot see yourself change is indistinguishable from one
//     that did not apply.
//  2. pi **clamps** the level to what the current model supports, so the value in
//     effect can differ from the value asked for. Echoing the request (rather
//     than re-reading the session) would show a lie; the broadcast has to carry
//     the clamped value.
import { describe, it, expect, beforeEach } from "vitest";
import { SessionService } from "../src/sessions.js";
import { UiHost } from "../src/uihost.js";
import type { S2C } from "@uipi/protocol";

type State = Extract<S2C, { type: "proto.sessionState" }>;

/**
 * A live session whose `setThinkingLevel` clamps the way pi does: a model that
 * does not reason stays at `off`, and a `max` request degrades to `xhigh`.
 */
function fakeLive(opts: { reasons?: boolean } = {}) {
  const reasons = opts.reasons ?? true;
  const session = {
    isIdle: true,
    thinkingLevel: "off" as string,
    messages: [],
    model: { provider: "p", id: "m" },
    sessionManager: { getBranch: () => [] },
    getActiveToolNames: () => ["read"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: () => Promise.resolve(),
    setModel: () => Promise.resolve(true),
    setThinkingLevel(level: string) {
      if (!reasons) {
        this.thinkingLevel = "off";
        return;
      }
      this.thinkingLevel = level === "max" ? "xhigh" : level;
    },
    modelRuntime: { getModel: (provider: string, id: string) => ({ provider, id }) },
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
  };
  const uiHost = new UiHost(() => "s1", "rpc");
  uiHost.attachSend(() => {});
  return {
    id: "s1",
    cwd: "/proj",
    agentDir: "/agent",
    sessionFile: "/tmp/s1.jsonl",
    runtime: { session } as never,
    session: session as never,
    uiHost,
    subscribers: new Map(),
    unsubscribe: () => {},
    createdAt: Date.now(),
  };
}

function seed(svc: SessionService, live: unknown): void {
  (svc as unknown as { live: Map<string, unknown> }).live.set("s1", live);
}

async function setLevel(
  svc: SessionService,
  level: string,
): Promise<{ states: State[]; errors: string[] }> {
  const states: State[] = [];
  const errors: string[] = [];
  const live = (
    svc as unknown as { live: Map<string, { subscribers: Map<unknown, true> }> }
  ).live.get("s1")!;
  live.subscribers.set(
    {
      send: (m: S2C) => {
        if (m.type === "proto.sessionState") states.push(m as State);
        if (m.type === "proto.error") errors.push(m.message);
      },
    },
    true,
  );
  await svc.handleSessionCmd(
    { type: "pi.setThinkingLevel", sessionId: "s1", level } as never,
    (m) => {
      if (m.type === "proto.error") errors.push(m.message);
    },
  );
  return { states, errors };
}

describe("pi.setThinkingLevel", () => {
  let svc: SessionService;

  beforeEach(() => {
    svc = new SessionService(undefined as never);
  });

  it("broadcasts the new state, so the picker can show the change", async () => {
    const live = fakeLive();
    seed(svc, live);
    const { states, errors } = await setLevel(svc, "high");

    expect(errors).toEqual([]);
    expect(states, "the level change must be broadcast").toHaveLength(1);
    expect(states[0].thinkingLevel).toBe("high");
  });

  it("broadcasts the level the session *has*, not the one requested", async () => {
    // pi clamps `max` to what the model supports; echoing the request would
    // render a level that is not in effect
    const live = fakeLive();
    seed(svc, live);
    const { states } = await setLevel(svc, "max");

    expect(states).toHaveLength(1);
    expect(states[0].thinkingLevel).toBe("xhigh");
  });

  it("reports `off` for a non-reasoning model, whatever was asked for", async () => {
    const live = fakeLive({ reasons: false });
    seed(svc, live);
    const { states } = await setLevel(svc, "high");

    expect(states).toHaveLength(1);
    expect(states[0].thinkingLevel).toBe("off");
  });

  it("refuses an unknown level instead of persisting it", async () => {
    const live = fakeLive();
    seed(svc, live);
    const { states, errors } = await setLevel(svc, "turbo");

    expect(errors.join(" ")).toContain("unknown thinking level");
    // and nothing pretending to have changed
    expect(states).toHaveLength(0);
    expect((live.session as unknown as { thinkingLevel: string }).thinkingLevel).toBe("off");
  });

  it("accepts every level pi defines", async () => {
    seed(svc, fakeLive());
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const { errors } = await setLevel(svc, level);
      expect(errors, `${level} must be accepted`).toEqual([]);
    }
  });
});
