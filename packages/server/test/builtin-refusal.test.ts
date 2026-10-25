// pi's builtin slash commands are TUI-only.
//
// `/model`, `/session`, `/help`, `/theme`, `/mcp`, `/login`, … are implemented
// in InteractiveMode, not in AgentSession.prompt(). If the web client sends
// `/model opus` as prompt text, prompt() finds no extension command and hands the
// literal string to the model — which then answers confidently about a command
// that never ran. The server must refuse those with proto.error instead.
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type Sent = S2C[];

/** A fake live session mirroring busy-dispatch.test.ts's fake. */
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

function setup(opts: { idle: boolean; commands?: { name: string; invocationName?: string }[] }) {
  const svc = new SessionService(undefined as never);
  const live = fakeLive(opts);
  const sent: Sent = [];
  const sub: Subscriber = { send: (m) => sent.push(m) };
  const map = (svc as unknown as { live: Map<string, unknown> }).live;
  map.set(live.id, live);
  live.subscribers = new Map([[sub, true]]);
  const errors = () => sent.filter((m) => m.type === "proto.error") as { message: string }[];
  // replies (incl. proto.error) go to the reply callback, broadcasts to subscribers
  const reply = (m: S2C) => sent.push(m);
  return { svc, live, sent, errors, reply };
}

const ROLE = [{ name: "role", invocationName: "role" }];

describe("pi builtin slash command refusal", () => {
  it("refuses a builtin with no web equivalent while idle and never prompts", async () => {
    const { svc, live, errors, reply } = setup({ idle: true, commands: ROLE });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/model opus" } as never,
      reply,
    );

    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toContain("not available in the web UI");
    expect(errors()[0].message).toContain("model");
    expect(live.prompts).toEqual([]);
    expect(live.queues.followUp).toEqual([]);
  });

  it("refuses the same builtin while busy and never queues a follow-up", async () => {
    const { svc, live, errors, reply } = setup({ idle: false, commands: ROLE });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/model opus" } as never,
      reply,
    );

    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toContain("not available in the web UI");
    expect(live.prompts).toEqual([]);
    expect(live.queues.followUp).toEqual([]);
  });

  it("still dispatches a registered extension command via prompt()", async () => {
    const { svc, live, errors, reply } = setup({ idle: true, commands: ROLE });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/role architect" } as never,
      reply,
    );

    expect(live.prompts).toEqual(["/role architect"]);
    expect(errors()).toHaveLength(0);
  });

  it("still queues an unknown slash string as a follow-up while busy", async () => {
    const { svc, live, errors, reply } = setup({ idle: false, commands: ROLE });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/notacommand" } as never,
      reply,
    );

    expect(live.queues.followUp).toEqual(["/notacommand"]);
    expect(live.prompts).toEqual([]);
    expect(errors()).toHaveLength(0);
  });

  it("still triggers compaction for /compact", async () => {
    const { svc, live, errors, reply } = setup({ idle: false, commands: ROLE });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/compact" } as never,
      reply,
    );

    expect(live.compactions).toEqual(["compact"]);
    expect(live.prompts).toEqual([]);
    expect(live.queues.followUp).toEqual([]);
    expect(errors()).toHaveLength(0);
  });
});
