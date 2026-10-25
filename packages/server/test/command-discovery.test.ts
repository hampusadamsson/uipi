// Slash-command discovery replaces the `commands: []` placeholders.
//
// Sources are pi's own three, read off the live AgentSession:
//  - `session.extensionRunner.getRegisteredCommands()` → `invocationName`
//  - `session.promptTemplates`                         → template name
//  - `session.resourceLoader.getSkills().skills`       → `skill:<name>`
//
// ONE naming rule: the name is what the user types *without* the leading "/",
// the client adds the slash. So `role`, `review`, `skill:pdf`.
//
// pi's TUI builtins (`/model`, `/session`, `/help`, …) are handled by
// InteractiveMode and never registered as an extension command/template/skill,
// so they cannot leak in — and the picker must not advertise them because the
// server refuses them (`isWebUnavailableBuiltin`).
import { describe, it, expect } from "vitest";
import { SessionService, discoverCommands } from "../src/sessions.js";
import { UiHost } from "../src/uihost.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type FakeOpts = {
  commands?: { name: string; invocationName?: string; description?: string }[];
  templates?: { name: string; description?: string }[];
  skills?: { name: string; description?: string }[];
  /** make the extension command list throw, as a stale runner would */
  throwOnCommands?: boolean;
  /** omit every discovery accessor, as a minimal fake session does */
  bare?: boolean;
};

/** A fake AgentSession exposing exactly the three discovery surfaces. */
function fakeSession(opts: FakeOpts = {}) {
  const session: Record<string, unknown> = {
    isIdle: true,
    thinkingLevel: "medium",
    messages: [],
    model: undefined,
    sessionManager: { getBranch: () => [] },
    getActiveToolNames: () => ["read"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: () => Promise.resolve(),
    setModel: () => Promise.resolve(true),
    modelRuntime: {
      getModel: (provider: string, modelId: string) => ({ provider, id: modelId }),
    },
  };
  if (!opts.bare) {
    session.extensionRunner = {
      getRegisteredCommands: () => {
        if (opts.throwOnCommands) throw new Error("extension runner is stale");
        return opts.commands ?? [];
      },
    };
    session.promptTemplates = opts.templates ?? [];
    session.resourceLoader = { getSkills: () => ({ skills: opts.skills ?? [] }) };
  }
  return session;
}

const EXTENSION = { name: "role", invocationName: "role", description: "Switch role" };
const TEMPLATE = { name: "review", description: "Review the diff" };
const SKILL = { name: "pdf", description: "Read PDFs" };

/** A fake live session good enough for handleSessionCmd + attachPayload. */
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

const ALL_SOURCES = { commands: [EXTENSION], templates: [TEMPLATE], skills: [SKILL] };

describe("discoverCommands", () => {
  it("maps extension, prompt-template and skill commands to slashless names", () => {
    expect(discoverCommands(fakeSession(ALL_SOURCES) as never)).toEqual([
      { name: "review", description: "Review the diff" },
      { name: "role", description: "Switch role" },
      { name: "skill:pdf", description: "Read PDFs" },
    ]);
  });

  it("uses invocationName so duplicate registrations stay distinguishable", () => {
    const commands = [
      { name: "deploy", invocationName: "deploy:1" },
      { name: "deploy", invocationName: "deploy:2" },
    ];
    expect(discoverCommands(fakeSession({ commands }) as never).map((c) => c.name)).toEqual([
      "deploy:1",
      "deploy:2",
    ]);
  });

  it("omits an empty description instead of sending an empty string", () => {
    const commands = [{ name: "role", invocationName: "role", description: "" }];
    expect(discoverCommands(fakeSession({ commands }) as never)).toEqual([{ name: "role" }]);
  });

  it("deduplicates by name, sorted for stable picker order", () => {
    const session = fakeSession({
      commands: [{ name: "review", invocationName: "role" }, { name: "role" }],
      templates: [TEMPLATE],
      skills: [SKILL],
    });
    expect(discoverCommands(session as never).map((c) => c.name)).toEqual([
      "review",
      "role",
      "skill:pdf",
    ]);
  });

  it("fails soft with [] when a discovery source throws", () => {
    expect(discoverCommands(fakeSession({ throwOnCommands: true }) as never)).toEqual([]);
  });

  it("fails soft with [] when the discovery surfaces are absent", () => {
    expect(discoverCommands(fakeSession({ bare: true }) as never)).toEqual([]);
  });

  it("never advertises pi's TUI builtins", () => {
    const names = discoverCommands(fakeSession(ALL_SOURCES) as never).map((c) => c.name);
    const builtins = [
      "settings",
      "model",
      "tree",
      "thinking",
      "scoped-models",
      "export",
      "import",
      "share",
      "bug",
      "copy",
      "name",
      "session",
      "changelog",
      "hotkeys",
      "fork",
      "clone",
      "trust",
      "login",
      "logout",
      "new",
      "compact",
      "resume",
      "reload",
      "quit",
    ];
    for (const builtin of builtins) expect(names).not.toContain(builtin);
  });
});

describe("commands in proto.attached", () => {
  it("carries the discovered list", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive(ALL_SOURCES);
    const sent: S2C[] = [];
    seed(svc, live);

    await svc.handle({ type: "proto.attach", sessionId: "s1" } as never, (m) => sent.push(m), {
      send: (m) => sent.push(m),
    });

    const attached = sent.find((m) => m.type === "proto.attached") as
      { commands: { name: string }[] } | undefined;
    expect(attached?.commands.map((c) => c.name)).toEqual(["review", "role", "skill:pdf"]);
  });

  it("still attaches with an empty list when discovery throws", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive({ throwOnCommands: true });
    const sent: S2C[] = [];
    seed(svc, live);

    await svc.handle({ type: "proto.attach", sessionId: "s1" } as never, (m) => sent.push(m), {
      send: (m) => sent.push(m),
    });

    expect(sent.some((m) => m.type === "proto.error")).toBe(false);
    const attached = sent.find((m) => m.type === "proto.attached") as
      { commands: unknown[] } | undefined;
    expect(attached?.commands).toEqual([]);
  });
});

describe("commands in proto.sessionState", () => {
  it("the proto.setRole broadcast carries the discovered list", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive(ALL_SOURCES);
    const sent: S2C[] = [];
    live.subscribers.set({ send: (m) => sent.push(m) }, true);
    seed(svc, live);

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: "architect" } as never,
      (m) => sent.push(m),
    );

    const state = sent.find((m) => m.type === "proto.sessionState") as
      { commands: { name: string }[] } | undefined;
    expect(state?.commands.map((c) => c.name)).toEqual(["review", "role", "skill:pdf"]);
  });

  it("the pi.setModel broadcast carries the discovered list", async () => {
    const svc = new SessionService(undefined as never);
    const live = fakeLive(ALL_SOURCES);
    const sent: S2C[] = [];
    live.subscribers.set({ send: (m) => sent.push(m) }, true);
    seed(svc, live);

    await svc.handleSessionCmd(
      { type: "pi.setModel", sessionId: "s1", provider: "anthropic", modelId: "opus" } as never,
      (m) => sent.push(m),
    );

    const state = sent.find((m) => m.type === "proto.sessionState") as
      { commands: { name: string }[] } | undefined;
    expect(state?.commands.map((c) => c.name)).toEqual(["review", "role", "skill:pdf"]);
  });
});
