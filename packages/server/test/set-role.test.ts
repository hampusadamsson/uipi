// `proto.setRole` is a translation layer, nothing more: the roles extension's
// own `/role` command is what runs. Three translations carry behaviour, so they
// are pinned here because `role-mirror.test.ts` only exercises the happy path
// with a role *name*:
//
//  1. `role: null` → `/role none` (the extension's reserved word for "clear").
//  2. `reload: true` → `/role reload` *first*, then the switch, so a hand-edited
//     roles.json is re-read before the new role is resolved.
//  3. An extension refusal (mid-run: "Agent busy — switch roles when idle")
//     must leave the broadcast state untouched — role, model, thinking level and
//     tools all as they were — and must not surface as `proto.error`: the
//     extension reports it through `ctx.ui.notify` (a `ui.event`), which is what
//     makes the web UI toast it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import { UiHost } from "../src/uihost.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type RoleEntry = { type: "custom"; customType: string; data?: unknown };

function roleSwitch(role: string | null): RoleEntry {
  return { type: "custom", customType: "role-switch", data: { role } };
}

/**
 * A fake live session with real state: `prompt("/role …")` is handled the way
 * the roles extension handles it, so the assertions are about the wire, not
 * about pi.
 */
function fakeLive(opts: { entries: RoleEntry[]; busy?: boolean }) {
  const prompts: string[] = [];
  const session = {
    get isIdle() {
      return !opts.busy;
    },
    thinkingLevel: "medium",
    messages: [],
    model: { provider: "p", id: "m" },
    sessionManager: { getBranch: () => opts.entries },
    getActiveToolNames: () => ["read"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: (text: string) => {
      prompts.push(text);
      const arg = text.startsWith("/role ") ? text.slice("/role ".length) : undefined;
      if (arg === undefined) return Promise.resolve();
      if (arg === "reload") return Promise.resolve();
      if (opts.busy) {
        // the extension refuses mid-run and records nothing
        return Promise.resolve();
      }
      opts.entries.push(roleSwitch(arg === "none" ? null : arg));
      if (arg === "architect") {
        // a role is a preset: model / thinking / tools move with it
        session.model = { provider: "p", id: "opus" };
        session.thinkingLevel = "high";
      }
      return Promise.resolve();
    },
  };
  const uiHost = new UiHost(() => "s1", "rpc");
  const frames: S2C[] = [];
  uiHost.attachSend((m) => frames.push(m));
  return {
    id: "s1",
    cwd: "/tmp",
    agentDir: mkdtempSync(join(tmpdir(), "uipi-setrole-")),
    sessionFile: undefined,
    session,
    uiHost,
    subscribers: new Map<Subscriber, true>(),
    frames,
    prompts,
  };
}

function setup(opts: { entries: RoleEntry[]; busy?: boolean }) {
  const svc = new SessionService(undefined as never);
  const live = fakeLive(opts);
  const sent: S2C[] = [];
  live.subscribers.set({ send: (m) => sent.push(m) }, true);
  (svc as unknown as { live: Map<string, unknown> }).live.set("s1", live);
  const states = () => sent.filter((m) => m.type === "proto.sessionState") as States[];
  const errors = () => sent.filter((m) => m.type === "proto.error") as { message: string }[];
  return { svc, live, sent, states, errors };
}

type States = Extract<S2C, { type: "proto.sessionState" }>;

describe("proto.setRole → the extension's own /role command", () => {
  it("role: null runs /role none and reports a null role", async () => {
    const { svc, live, states, errors } = setup({ entries: [roleSwitch("work")] });

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: null } as never,
      () => {},
    );

    // the extension is the authority: its reserved word, not a uipi invention
    expect(live.prompts).toEqual(["/role none"]);
    expect(errors()).toHaveLength(0);

    const state = states().at(-1)!;
    expect(state.type).toBe("proto.sessionState");
    expect(state.role).toBeNull();
    expect(state.sessionId).toBe("s1");
    // the same message restates the rest of the runtime state
    expect(state.model).toEqual({ provider: "p", modelId: "m" });
    expect(state.thinkingLevel).toBe("medium");
    expect(state.tools).toEqual(["read"]);
  });

  it("role: null clears an already-roleless session without erroring", async () => {
    const { svc, live, states } = setup({ entries: [roleSwitch(null)] });

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: null } as never,
      () => {},
    );

    expect(live.prompts).toEqual(["/role none"]);
    expect(states().at(-1)?.role).toBeNull();
  });

  it("reload: true runs /role reload first, then the switch", async () => {
    const { svc, live, states } = setup({ entries: [roleSwitch("work")] });

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: "architect", reload: true } as never,
      () => {},
    );

    expect(live.prompts).toEqual(["/role reload", "/role architect"]);
    const state = states().at(-1)!;
    expect(state.role).toBe("architect");
    expect(state.model).toEqual({ provider: "p", modelId: "opus" });
    expect(state.thinkingLevel).toBe("high");
  });

  it("a named switch reports the state that follows the role, not the old one", async () => {
    const { svc, states } = setup({ entries: [roleSwitch("work")] });

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: "architect" } as never,
      () => {},
    );

    const state = states().at(-1)!;
    expect(state.role).toBe("architect");
    expect(state.model).toEqual({ provider: "p", modelId: "opus" });
  });
});

describe("proto.setRole when the extension refuses (Agent busy)", () => {
  it("leaves role, model, thinkingLevel and tools exactly as they were", async () => {
    const { svc, live, states, errors } = setup({ entries: [roleSwitch("work")], busy: true });

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: "architect" } as never,
      () => {},
    );

    // the switch was still attempted — that is what produces the extension's toast
    expect(live.prompts).toEqual(["/role architect"]);

    const state = states().at(-1)!;
    expect(state.role).toBe("work"); // history unchanged
    expect(state.model).toEqual({ provider: "p", modelId: "m" });
    expect(state.thinkingLevel).toBe("medium");
    expect(state.tools).toEqual(["read"]);

    // a refusal is a ui.event notification, not a protocol error
    expect(errors()).toHaveLength(0);
  });

  it("broadcasts exactly one sessionState per request, even on refusal", async () => {
    const { svc, states } = setup({ entries: [roleSwitch("work")], busy: true });

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: "architect" } as never,
      () => {},
    );

    expect(states()).toHaveLength(1);
  });

  it("errors for an unknown session instead of prompting", async () => {
    const svc = new SessionService(undefined as never);
    const sent: S2C[] = [];
    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "nope", role: "work" } as never,
      (m) => sent.push(m),
    );
    expect(sent.some((m) => m.type === "proto.error")).toBe(true);
    expect(sent.some((m) => m.type === "proto.sessionState")).toBe(false);
  });
});
