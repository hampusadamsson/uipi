// Renaming a session from the web UI.
//
// pi implements `/name` in InteractiveMode, not in `AgentSession.prompt()`: the
// prompt path finds no extension command and hands the literal text to the
// model, which then answers about a command that never ran. So the server
// intercepts `/name[ <rest>]` in `pi.prompt` (before the TUI-builtin refusal)
// and calls `AgentSession.setSessionName` itself — the name is pi's own,
// persisted as a `session_info` entry, so it survives a reload and shows up as
// `info.name` in `SessionManager.list()` (i.e. the sidebar's `displayName`).
//
// `proto.setSessionName` is the same operation over the wire, for a rename UI
// that does not type a slash command.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import { UiHost } from "../src/uihost.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type Names = Extract<S2C, { type: "proto.sessionName" }>;

/** A fake live session good enough for the `pi.prompt` and proto.* paths. */
function fakeLive(opts: { idle?: boolean; name?: string | null } = {}) {
  const prompts: string[] = [];
  const renames: string[] = [];
  let name = opts.name ?? null;
  const session = {
    get isIdle() {
      return opts.idle ?? true;
    },
    get sessionName() {
      return name ?? undefined;
    },
    // real pi: void, so the server's `await` must tolerate a non-promise
    setSessionName: (next: string) => {
      renames.push(next);
      name = next === "" ? null : next;
    },
    prompt: (text: string) => {
      prompts.push(text);
      return Promise.resolve();
    },
    followUp: (text: string) => {
      prompts.push(`followUp:${text}`);
    },
    steer: () => {},
    compact: () => Promise.resolve({}),
    thinkingLevel: "medium",
    messages: [] as unknown[],
    model: { provider: "p", id: "m" },
    getActiveToolNames: () => ["read"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    extensionRunner: { getRegisteredCommands: () => [] },
  };
  const uiHost = new UiHost(() => "s1", "rpc");
  const frames: S2C[] = [];
  uiHost.attachSend((m) => frames.push(m));
  return {
    id: "s1",
    cwd: "/tmp",
    agentDir: mkdtempSync(join(tmpdir(), "uipi-name-")),
    sessionFile: undefined,
    session,
    uiHost,
    subscribers: new Map<Subscriber, true>(),
    prompts,
    renames,
    frames,
  };
}

function setup(opts: { idle?: boolean; name?: string | null } = {}) {
  const svc = new SessionService(undefined as never);
  const live = fakeLive(opts);
  // Two channels, as the transport has them: broadcasts reach this session's
  // subscribers, replies (command acks / proto.error) go to the requesting socket.
  const broadcast: S2C[] = [];
  const replies: S2C[] = [];
  live.subscribers.set({ send: (m) => broadcast.push(m) }, true);
  (svc as unknown as { live: Map<string, unknown> }).live.set("s1", live);
  // Keep the sidebar refresh hermetic: replySessions() is still *called* (the
  // fake records the proto.sessions frame), but it must not scan the real
  // filesystem for session files.
  (svc as unknown as { listAllSessions: () => Promise<unknown[]> }).listAllSessions =
    async () => [];
  const names = () => broadcast.filter((m) => m.type === "proto.sessionName") as Names[];
  const sessions = () =>
    [...broadcast, ...replies].filter((m) => m.type === "proto.sessions") as {
      type: "proto.sessions";
    }[];
  const errors = () => replies.filter((m) => m.type === "proto.error") as { message: string }[];
  const reply = (m: S2C) => replies.push(m);
  return { svc, live, broadcast, replies, names, sessions, errors, reply };
}

describe("/name through pi.prompt", () => {
  it("sets the name and never gives the text to the model", async () => {
    const { svc, live, broadcast, names, sessions, errors, reply } = setup();

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/name my refactor" } as never,
      reply,
    );

    expect(live.renames).toEqual(["my refactor"]);
    // the literal slash text must not reach pi's prompt/queue at all
    expect(live.prompts).toEqual([]);
    expect(errors()).toHaveLength(0);
    // subscribers learn the new name without a refetch …
    expect(names()).toEqual([{ type: "proto.sessionName", sessionId: "s1", name: "my refactor" }]);
    // … and the sidebar list is re-sent
    expect(sessions().length).toBeGreaterThan(0);
    expect(broadcast.some((m) => m.type === "proto.sessionName")).toBe(true);
  });

  it("trims the rest of the line", async () => {
    const { svc, live, reply } = setup();

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/name   spaced  " } as never,
      reply,
    );

    expect(live.renames).toEqual(["spaced"]);
  });

  it("clears the name when no argument is given", async () => {
    const { svc, live, names, errors, reply } = setup({ name: "old" });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/name" } as never,
      reply,
    );

    // an empty rest is what pi treats as "clear"
    expect(live.renames).toEqual([""]);
    expect(live.session.sessionName).toBeUndefined();
    expect(names()).toEqual([{ type: "proto.sessionName", sessionId: "s1", name: null }]);
    expect(errors()).toHaveLength(0);
  });

  it("works while the agent is busy and never queues a follow-up", async () => {
    const { svc, live, reply } = setup({ idle: false });

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/name mid-run" } as never,
      reply,
    );

    expect(live.renames).toEqual(["mid-run"]);
    expect(live.prompts).toEqual([]);
  });

  it("does not treat /namex as the command", async () => {
    const { svc, live, names, reply } = setup();

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "s1", text: "/namex foo" } as never,
      reply,
    );

    expect(live.renames).toEqual([]);
    expect(names()).toEqual([]);
    // an unknown slash string keeps the existing behaviour: forwarded as a prompt
    expect(live.prompts).toEqual(["/namex foo"]);
  });

  it("refuses /name on an unknown session", async () => {
    const { svc, errors, reply } = setup();

    await svc.handleSessionCmd(
      { type: "pi.prompt", sessionId: "nope", text: "/name foo" } as never,
      reply,
    );

    expect(errors()[0]?.message).toContain("no such live session nope");
  });
});

describe("proto.setSessionName", () => {
  it("sets the name, broadcasts it and replies with proto.sessionName", async () => {
    const { svc, live, names, replies, sessions, errors, reply } = setup();

    await svc.handle(
      { type: "proto.setSessionName", sessionId: "s1", name: " nightly " } as never,
      reply,
      { send: () => {} },
    );

    expect(live.renames).toEqual(["nightly"]);
    expect(live.prompts).toEqual([]);
    // the session's subscribers see the change
    expect(names()).toEqual([{ type: "proto.sessionName", sessionId: "s1", name: "nightly" }]);
    // the requester gets the same frame back as its ack
    expect(replies.filter((m) => m.type === "proto.sessionName")).toEqual([
      { type: "proto.sessionName", sessionId: "s1", name: "nightly" },
    ]);
    expect(sessions().length).toBeGreaterThan(0);
    expect(errors()).toHaveLength(0);
  });

  it("clears the name with an empty string, reporting null", async () => {
    const { svc, live, names, reply } = setup({ name: "old" });

    await svc.handle({ type: "proto.setSessionName", sessionId: "s1", name: "" } as never, reply, {
      send: () => {},
    });

    expect(live.renames).toEqual([""]);
    expect(names()).toEqual([{ type: "proto.sessionName", sessionId: "s1", name: null }]);
  });

  it("answers proto.error for an unknown session", async () => {
    const { svc, replies, reply } = setup();

    await svc.handle(
      { type: "proto.setSessionName", sessionId: "nope", name: "x" } as never,
      reply,
      { send: () => {} },
    );

    expect(replies.some((m) => m.type === "proto.error")).toBe(true);
    expect(replies.some((m) => m.type === "proto.sessionName")).toBe(false);
  });
});

describe("current name in the attach payloads", () => {
  it("proto.attached carries the session's name", async () => {
    const { svc, replies, reply } = setup({ name: "my refactor" });

    await svc.handle({ type: "proto.attach", sessionId: "s1" } as never, reply, {
      send: () => {},
    });

    const attached = replies.find((m) => m.type === "proto.attached") as
      { name: string | null } | undefined;
    expect(attached?.name).toBe("my refactor");
  });

  it("proto.attached reports null for an unnamed session", async () => {
    const { svc, replies, reply } = setup();

    await svc.handle({ type: "proto.attach", sessionId: "s1" } as never, reply, {
      send: () => {},
    });

    const attached = replies.find((m) => m.type === "proto.attached") as
      { name: string | null } | undefined;
    expect(attached?.name).toBeNull();
  });
});
