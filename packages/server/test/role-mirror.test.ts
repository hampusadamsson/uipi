// The active role is pi's role, read back from session history — uipi never
// validates or re-derives it.
//
// Two rules pinned here:
//  1. The mirror is the LAST `role-switch` custom entry on the branch (an entry
//     with `role: null` counts as "roleless", not "no answer").
//  2. A broadcast reports the role the session *has*. Before this, `setRole`
//     echoed the requested name, so an extension refusal (unknown role, "Agent
//     busy") still painted the chip with a role that was never applied.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SessionService, mirrorActiveRole } from "../src/sessions.js";
import { UiHost } from "../src/uihost.js";
import type { Subscriber } from "../src/types.js";
import type { S2C } from "@uipi/protocol";

type RoleEntry = { type: "custom"; customType: string; data?: unknown };

/** A fake AgentSession whose branch is a plain array we can extend at will. */
function fakeSession(entries: RoleEntry[] = []) {
  return {
    isIdle: true,
    thinkingLevel: "medium",
    messages: [],
    model: undefined,
    sessionManager: { getBranch: () => entries },
    getActiveToolNames: () => ["read"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: () => Promise.resolve(),
  };
}

function agentDirWithRoles(roles: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "uipi-roles-"));
  if (roles !== undefined) writeFileSync(join(dir, "roles.json"), JSON.stringify(roles));
  return dir;
}

function roleSwitch(role: string | null): RoleEntry {
  return { type: "custom", customType: "role-switch", data: { role } };
}

function seed(svc: SessionService, live: unknown): void {
  (svc as unknown as { live: Map<string, unknown> }).live.set("s1", live);
}

describe("role mirror", () => {
  it("returns the LAST role-switch entry when several exist", () => {
    const session = fakeSession([
      roleSwitch("coder"),
      { type: "custom", customType: "something-else", data: { role: "ignored" } },
      roleSwitch("work"),
    ]);
    expect(mirrorActiveRole(session as never, "/nonexistent-agent-dir")).toBe("work");
  });

  it("returns null when no role-switch entry exists and there is no config", () => {
    const session = fakeSession([{ type: "custom", customType: "todo", data: {} }]);
    expect(mirrorActiveRole(session as never, agentDirWithRoles(undefined))).toBeNull();
  });

  it("treats a role:null entry as roleless instead of falling back to the config", () => {
    const dir = agentDirWithRoles({ active: "coder" });
    const session = fakeSession([roleSwitch("work"), roleSwitch(null)]);
    expect(mirrorActiveRole(session as never, dir)).toBeNull();
  });

  it("fails soft when the session manager throws", () => {
    const session = {
      sessionManager: {
        getBranch: () => {
          throw new Error("no session");
        },
      },
    };
    expect(mirrorActiveRole(session as never, "/nonexistent-agent-dir")).toBeNull();
  });
});

describe("role mirror — roles.json fallback (unpatched installs)", () => {
  it("uses roles.json → active when history has no role-switch entry", () => {
    const dir = agentDirWithRoles({ active: "architect" });
    expect(mirrorActiveRole(fakeSession() as never, dir)).toBe("architect");
  });

  it("returns null for malformed roles.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "uipi-roles-"));
    writeFileSync(join(dir, "roles.json"), "{ not json");
    expect(mirrorActiveRole(fakeSession() as never, dir)).toBeNull();
  });

  it("returns null when active is missing or not a string", () => {
    expect(mirrorActiveRole(fakeSession() as never, agentDirWithRoles({}))).toBeNull();
    expect(mirrorActiveRole(fakeSession() as never, agentDirWithRoles({ active: 42 }))).toBeNull();
  });
});

/** A fake live session good enough for `handleSessionCmd` + `attachPayload`. */
function fakeLive(entries: RoleEntry[], agentDir: string) {
  const session = fakeSession(entries);
  const uiHost = new UiHost(() => "s1", "rpc");
  uiHost.attachSend(() => {});
  uiHost.ui.setStatus("role", "◆ work");
  return {
    id: "s1",
    cwd: "/tmp",
    agentDir,
    sessionFile: undefined,
    session,
    uiHost,
    subscribers: new Map<Subscriber, true>(),
  };
}

describe("proto.setRole broadcast", () => {
  it("reports the mirrored role, not the requested one", async () => {
    const dir = agentDirWithRoles(undefined);
    const entries: RoleEntry[] = [roleSwitch("work")];
    const live = fakeLive(entries, dir);
    // the extension refuses this switch: history is unchanged after prompt()
    live.session.prompt = () => Promise.resolve();

    const svc = new SessionService(undefined as never);
    const sent: S2C[] = [];
    live.subscribers.set({ send: (m) => sent.push(m) }, true);
    seed(svc, live);

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: "architect" } as never,
      (m) => sent.push(m),
    );

    const state = sent.find((m) => m.type === "proto.sessionState") as
      { role: string | null } | undefined;
    expect(state?.role).toBe("work");
  });

  it("reports the new role once the extension records it", async () => {
    const dir = agentDirWithRoles(undefined);
    const entries: RoleEntry[] = [roleSwitch("work")];
    const live = fakeLive(entries, dir);
    live.session.prompt = (text: string) => {
      const name = text.replace("/role ", "");
      entries.push(roleSwitch(name));
      return Promise.resolve();
    };

    const svc = new SessionService(undefined as never);
    const sent: S2C[] = [];
    live.subscribers.set({ send: (m) => sent.push(m) }, true);
    seed(svc, live);

    await svc.handleSessionCmd(
      { type: "proto.setRole", sessionId: "s1", role: "architect" } as never,
      (m) => sent.push(m),
    );

    const state = sent.find((m) => m.type === "proto.sessionState") as
      { role: string | null } | undefined;
    expect(state?.role).toBe("architect");
  });
});

describe("proto.attached payload", () => {
  it("includes the mirrored role and a non-empty statuses snapshot", async () => {
    const dir = agentDirWithRoles(undefined);
    const live = fakeLive([roleSwitch("work")], dir);
    const svc = new SessionService(undefined as never);
    const sent: S2C[] = [];
    seed(svc, live);

    await svc.handle({ type: "proto.attach", sessionId: "s1" } as never, (m) => sent.push(m), {
      send: (m) => sent.push(m),
    });

    const attached = sent.find((m) => m.type === "proto.attached") as
      { role: string | null; statuses: Record<string, string>; commands: unknown[] } | undefined;
    expect(attached?.role).toBe("work");
    expect(attached?.statuses).toEqual({ role: "◆ work" });
    expect(attached?.commands).toEqual([]);
  });

  it("falls back to roles.json → active for a fresh session", async () => {
    const dir = agentDirWithRoles({ active: "coder" });
    const live = fakeLive([], dir);
    const svc = new SessionService(undefined as never);
    const sent: S2C[] = [];
    seed(svc, live);

    await svc.handle({ type: "proto.attach", sessionId: "s1" } as never, (m) => sent.push(m), {
      send: (m) => sent.push(m),
    });

    const attached = sent.find((m) => m.type === "proto.attached") as
      { role: string | null } | undefined;
    expect(attached?.role).toBe("coder");
  });
});
