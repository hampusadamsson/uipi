// Role names over the wire: `proto.roleNames` is answered from the `/role`
// extension command's *own* argument completions.
//
// The roles extension (`~/.pi/agent/extensions/roles/index.ts`) is the single
// source of truth for which roles exist. Its `getArgumentCompletions` returns one
// `{ value, label, description }` per configured role plus its reserved words
// (`none`, `off`, `reload`, `keys`). uipi forwards the names and drops the
// reserved words, because `(none)` and reload are picker affordances of its own.
//
// Everything fails soft: extension missing, command missing, completion throwing
// or returning nothing → `names: []`, and the picker still works.
import { describe, it, expect } from "vitest";
import { SessionService, discoverRoleNames } from "../src/sessions.js";
import { UiHost } from "../src/uihost.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type CompletionItem = { value: string; label: string; description?: string };

type FakeOpts = {
  /** what the `role` command's completion returns (or throws) */
  completions?: CompletionItem[] | null | (() => Promise<CompletionItem[] | null>);
  /** register the command without a completion accessor, as a non-roles fake */
  noCompletionsAccessor?: boolean;
  /** register no commands at all (roles extension not installed) */
  noRoleCommand?: boolean;
  /** make getRegisteredCommands throw, as a stale runner would */
  throwOnCommands?: boolean;
};

/** The extension's real completion shape, reserved words included. */
const ROLE_ITEMS: CompletionItem[] = [
  { value: "work", label: "work", description: "everyday coding" },
  { value: "architect", label: "architect", description: "design first" },
  { value: "local", label: "local" }, // hidden: true in roles.json — still listed
  { value: "none", label: "none", description: "no role" },
  { value: "reload", label: "reload", description: "re-read roles.json" },
  { value: "keys", label: "keys", description: "cycle keys" },
];

function fakeSession(opts: FakeOpts = {}) {
  const roleCommand: Record<string, unknown> = { name: "role", invocationName: "role" };
  if (!opts.noCompletionsAccessor) {
    roleCommand.getArgumentCompletions = (prefix: string) => {
      const value = opts.completions;
      if (typeof value === "function") return value();
      const items = value === undefined ? ROLE_ITEMS : value;
      return items ? items.filter((i) => i.value.startsWith(prefix)) : null;
    };
  }
  const commands = opts.noRoleCommand ? [] : [roleCommand];
  return {
    isIdle: true,
    extensionRunner: {
      getRegisteredCommands: () => {
        if (opts.throwOnCommands) throw new Error("extension runner is stale");
        return commands;
      },
    },
  } as never;
}

function fakeLive(opts: FakeOpts = {}) {
  const uiHost = new UiHost(() => "s1", "rpc");
  uiHost.attachSend(() => {});
  return {
    id: "s1",
    cwd: "/tmp",
    agentDir: "/nonexistent-agent-dir",
    sessionFile: undefined,
    session: fakeSession(opts),
    uiHost,
    subscribers: new Map<Subscriber, true>(),
  };
}

function seed(svc: SessionService, live: unknown): void {
  (svc as unknown as { live: Map<string, unknown> }).live.set("s1", live);
}

async function requestNames(opts: FakeOpts = {}): Promise<S2C[]> {
  const svc = new SessionService(undefined as never);
  seed(svc, fakeLive(opts));
  const sent: S2C[] = [];
  await svc.handle({ type: "proto.roleNames", sessionId: "s1" } as never, (m) => sent.push(m), {
    send: (m) => sent.push(m),
  });
  return sent;
}

describe("discoverRoleNames", () => {
  it("maps the extension's completions to role names", async () => {
    expect(await discoverRoleNames(fakeSession())).toEqual(["work", "architect", "local"]);
  });

  it("filters the extension's reserved words (none/off/reload/keys)", async () => {
    const items: CompletionItem[] = [
      { value: "none", label: "none" },
      { value: "off", label: "off" },
      { value: "reload", label: "reload" },
      { value: "keys", label: "keys" },
      { value: "work", label: "work" },
    ];
    expect(await discoverRoleNames(fakeSession({ completions: items }))).toEqual(["work"]);
  });

  it("awaits async completions", async () => {
    const session = fakeSession({
      completions: async () => [{ value: "architect", label: "architect" }],
    });
    expect(await discoverRoleNames(session)).toEqual(["architect"]);
  });

  it("returns [] when no role command is registered (extension not installed)", async () => {
    expect(await discoverRoleNames(fakeSession({ noRoleCommand: true }))).toEqual([]);
  });

  it("returns [] when the role command has no completion accessor", async () => {
    expect(await discoverRoleNames(fakeSession({ noCompletionsAccessor: true }))).toEqual([]);
  });

  it("returns [] when completions throw", async () => {
    const session = fakeSession({
      completions: async () => {
        throw new Error("roles.json is broken");
      },
    });
    expect(await discoverRoleNames(session)).toEqual([]);
  });

  it("returns [] when the extension runner throws", async () => {
    expect(await discoverRoleNames(fakeSession({ throwOnCommands: true }))).toEqual([]);
  });

  it("returns [] when completions return null", async () => {
    expect(await discoverRoleNames(fakeSession({ completions: null }))).toEqual([]);
  });
});

describe("proto.roleNames reply", () => {
  it("replies with the filtered name list for the session", async () => {
    const sent = await requestNames();
    const reply = sent.find((m) => m.type === "proto.roleNames") as
      { sessionId: string; names: string[] } | undefined;
    expect(reply?.sessionId).toBe("s1");
    expect(reply?.names).toEqual(["work", "architect", "local"]);
    expect(sent.some((m) => m.type === "proto.error")).toBe(false);
  });

  it("replies with an empty list when the roles extension is absent", async () => {
    const sent = await requestNames({ noRoleCommand: true });
    const reply = sent.find((m) => m.type === "proto.roleNames") as { names: string[] } | undefined;
    expect(reply?.names).toEqual([]);
    expect(sent.some((m) => m.type === "proto.error")).toBe(false);
  });

  it("replies with an empty list when completions throw", async () => {
    const sent = await requestNames({ throwOnCommands: true });
    const reply = sent.find((m) => m.type === "proto.roleNames") as { names: string[] } | undefined;
    expect(reply?.names).toEqual([]);
    expect(sent.some((m) => m.type === "proto.error")).toBe(false);
  });

  it("errors on an unknown session instead of replying with names", async () => {
    const svc = new SessionService(undefined as never);
    const sent: S2C[] = [];
    await svc.handle({ type: "proto.roleNames", sessionId: "nope" } as never, (m) => sent.push(m), {
      send: (m) => sent.push(m),
    });
    expect(sent.some((m) => m.type === "proto.error")).toBe(true);
    expect(sent.some((m) => m.type === "proto.roleNames")).toBe(false);
  });
});
