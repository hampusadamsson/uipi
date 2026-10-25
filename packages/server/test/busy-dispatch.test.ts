// Slash commands must bypass the follow-up queue while the agent is busy.
//
// pi executes extension commands immediately, even during streaming
// (AgentSession.prompt → _tryExecuteExtensionCommand), and that is what the TUI
// relies on: typing `/role architect` mid-run switches the role. pi's followUp()
// calls _throwIfExtensionCommand and rejects the text, so the server must route
// registered extension commands through prompt() instead of queueing them.
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type Sent = S2C[];

/** A fake live session with a controllable busy flag, queue, and extension runner.
 *  `prompt()` refuses to run while busy — only extension commands may get through,
 *  exactly like pi (which handles them before the streaming check). */
function fakeLive(opts: { idle: boolean; commands?: { name: string; invocationName?: string }[] }) {
  const queues = { steering: [] as string[], followUp: [] as string[] };
  const prompts: string[] = [];
  const compactions: string[] = [];
  const commands = opts.commands ?? [];
  const session = {
    get isIdle() {
      return opts.idle;
    },
    prompt: (text: string) => {
      if (!opts.idle) {
        // pi handles extension commands before the "already processing" check
        const commandName = text.startsWith("/") ? text.slice(1).split(" ")[0] : undefined;
        const known = commands.some((c) => (c.invocationName ?? c.name) === commandName);
        if (!known) {
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          );
        }
      }
      prompts.push(text);
      return Promise.resolve();
    },
    followUp: (text: string) => {
      // pi: _throwIfExtensionCommand — registered commands cannot be queued
      const commandName = text.startsWith("/") ? text.slice(1).split(" ")[0] : undefined;
      if (commands.some((c) => (c.invocationName ?? c.name) === commandName)) {
        throw new Error(
          `Extension command "/${String(commandName)}" cannot be queued. Use prompt() or execute the command when not streaming.`,
        );
      }
      queues.followUp.push(text);
    },
    steer: (text: string) => queues.steering.push(text),
    compact: () => {
      compactions.push("compact");
      return Promise.resolve({});
    },
    getSteeringMessages: () => queues.steering,
    getFollowUpMessages: () => queues.followUp,
    clearQueue: () => {
      queues.steering.length = 0;
      queues.followUp.length = 0;
    },
    extensionRunner: {
      getRegisteredCommands: () => commands,
    },
  };
  return { id: "s1", session, prompts, queues, compactions };
}

function seed(svc: SessionService, live: ReturnType<typeof fakeLive>, sub: Subscriber) {
  const map = (svc as unknown as { live: Map<string, unknown> }).live;
  map.set(live.id, live);
  live.subscribers = new Map([[sub, true]]);
}

function setup(opts: { idle: boolean; commands?: { name: string; invocationName?: string }[] }) {
  const svc = new SessionService(undefined as never);
  const live = fakeLive(opts);
  const sent: Sent = [];
  const sub: Subscriber = { send: (m) => sent.push(m) };
  seed(svc, live, sub);
  const errors = () => sent.filter((m) => m.type === "proto.error");
  return { svc, live, sent, errors };
}

describe("busy-path dispatch", () => {
  it("dispatches a known extension command via prompt() while busy, not followUp()", async () => {
    const { svc, live, errors } = setup({
      idle: false,
      commands: [{ name: "role", invocationName: "role" }],
    });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/role architect" } as never,
      () => {},
    );

    expect(live.prompts).toEqual(["/role architect"]);
    expect(live.queues.followUp).toEqual([]);
    expect(errors()).toHaveLength(0);
  });

  it("matches on invocationName when an extension name is disambiguated", async () => {
    const { svc, live } = setup({
      idle: false,
      commands: [{ name: "role", invocationName: "role:1" }],
    });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/role:1 architect" } as never,
      () => {},
    );

    expect(live.prompts).toEqual(["/role:1 architect"]);
    expect(live.queues.followUp).toEqual([]);
  });

  it("still queues a normal message as a follow-up while busy", async () => {
    const { svc, live, errors } = setup({
      idle: false,
      commands: [{ name: "role", invocationName: "role" }],
    });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "second message" } as never,
      () => {},
    );

    expect(live.queues.followUp).toEqual(["second message"]);
    expect(live.prompts).toEqual([]);
    expect(errors()).toHaveLength(0);
  });

  it("prompts directly while idle", async () => {
    const { svc, live } = setup({
      idle: true,
      commands: [{ name: "role", invocationName: "role" }],
    });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "go" } as never,
      () => {},
    );

    expect(live.prompts).toEqual(["go"]);
    expect(live.queues.followUp).toEqual([]);
  });

  it("queues an unknown slash string as a follow-up while busy", async () => {
    const { svc, live, errors } = setup({
      idle: false,
      commands: [{ name: "role", invocationName: "role" }],
    });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/not-a-command whatever" } as never,
      () => {},
    );

    expect(live.queues.followUp).toEqual(["/not-a-command whatever"]);
    expect(live.prompts).toEqual([]);
    expect(live.compactions).toEqual([]);
    expect(errors()).toHaveLength(0);
  });

  it("routes a literal /compact while busy to the compaction path, not followUp()", async () => {
    const { svc, live, errors } = setup({ idle: false });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/compact" } as never,
      () => {},
    );

    expect(live.compactions).toEqual(["compact"]);
    expect(live.queues.followUp).toEqual([]);
    expect(live.prompts).toEqual([]);
    expect(errors()).toHaveLength(0);
  });

  it("replies with proto.error when the immediate dispatch throws", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive({ idle: false, commands: [{ name: "role", invocationName: "role" }] });
    live.session.prompt = () => Promise.reject(new Error("boom"));
    const sent: Sent = [];
    const sub: Subscriber = { send: () => {} };
    seed(svc, live, sub);

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/role architect" } as never,
      (m) => sent.push(m),
    );

    const err = sent.find((m) => m.type === "proto.error") as { message: string } | undefined;
    expect(err?.message).toContain("boom");
    expect(live.queues.followUp).toEqual([]);
  });
});
