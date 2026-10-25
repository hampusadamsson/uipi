// Role plumbing tests for the Svelte adapter: what the header chip renders,
// what the sidebar row shows, which rows the picker lists, and which slash items
// the input box offers.
//
// These pin the *view data* contract only — no Svelte mount needed, same style
// as state-adapter.svelte.test.ts. The wire shape is the client's
// (`proto.attached` / `proto.sessionState` / `proto.sessions`).
import { describe, it, expect } from "vitest";
import { UiState, sessionRoleText, rolePickerItems } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { S2C, SessionSummary } from "@uipi/protocol";

function session(id: string, over: Partial<AttachedSession> = {}): AttachedSession {
  return {
    sessionId: id,
    model: { provider: "p", modelId: "m1" },
    thinkingLevel: "off",
    tools: [],
    role: null,
    commands: [],
    statuses: {},
    cwd: "/proj",
    isStreaming: false,
    steering: [],
    followUp: [],
    sessionFile: "/tmp/s.jsonl",
    messages: [],
    events: [],
    ...over,
  } as AttachedSession;
}

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    displayName: "s1",
    firstMessage: "hi",
    mtime: 0,
    live: false,
    cwd: "/proj",
    role: null,
    ...over,
  };
}

type Internals = {
  attachedSessions: Map<string, AttachedSession>;
  activeId: string | null;
  handle: (m: S2C) => void;
};

function setup(over: Partial<AttachedSession> = {}) {
  const ui = new UiState();
  const c = ui.client as unknown as Internals;
  c.attachedSessions.set("s1", session("s1", over));
  c.activeId = "s1";
  sync(ui);
  return { ui, c };
}

function sync(ui: UiState): void {
  (ui as unknown as { sync: () => void }).sync();
}

describe("role chip (header)", () => {
  it("renders ◆ <role> from proto.attached", () => {
    const { ui } = setup({ role: "architect" });
    expect(ui.roleChip("s1")).toBe("◆ architect");
  });

  it("a proto.sessionState switch updates what the chip renders", () => {
    const { ui, c } = setup();
    expect(ui.roleChip("s1")).toBeNull(); // roleless to start

    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: "local", // hidden in roles.json — must NOT be filtered out
      model: null,
      thinkingLevel: "off",
      tools: [],
      commands: [],
    } as S2C);
    sync(ui);

    expect(ui.roleOf("s1")).toBe("local");
    expect(ui.roleChip("s1")).toBe("◆ local");
  });

  it("role null renders nothing", () => {
    const { ui, c } = setup({ role: "architect" });
    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: null,
      model: null,
      thinkingLevel: "off",
      tools: [],
      commands: [],
    } as S2C);
    sync(ui);

    expect(ui.roleOf("s1")).toBeNull();
    expect(ui.roleChip("s1")).toBeNull();
  });

  it("has no drift notion: a model change leaves the chip alone", () => {
    const { ui, c } = setup({ role: "architect" });
    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: "architect",
      model: { provider: "p", modelId: "something-else" },
      thinkingLevel: "high",
      tools: ["bash"],
      commands: [],
    } as S2C);
    sync(ui);
    expect(ui.roleChip("s1")).toBe("◆ architect");
  });
});

describe("sidebar role badge", () => {
  it("reads SessionSummary.role, including for non-live sessions", () => {
    const { ui, c } = setup();
    (c as unknown as { sessions: SessionSummary[] }).sessions = [
      summary({ sessionId: "s1", live: false, role: "architect" }),
      summary({ sessionId: "s2", sessionFile: "/tmp/s2.jsonl", live: false, role: null }),
    ];
    sync(ui);
    expect(ui.sessions.map(sessionRoleText)).toEqual(["architect", null]);
  });
});

describe("role picker data", () => {
  it("marks the current role and lists (none) + reload", () => {
    const items = rolePickerItems(["work", "architect"], "architect");
    expect(items.filter((i) => i.kind === "role").map((i) => i.label)).toEqual([
      "work",
      "architect",
    ]);
    expect(items.find((i) => i.label === "architect")?.current).toBe(true);
    expect(items.find((i) => i.label === "work")?.current).toBe(false);
    expect(items.some((i) => i.kind === "none")).toBe(true);
    expect(items.some((i) => i.kind === "reload")).toBe(true);
  });

  it("role names keep the extension's order (roles.json order), not sorted", () => {
    expect(rolePickerItems(["work", "architect"], null).map((i) => i.kind + ":" + i.label)).toEqual(
      [
        "role:work",
        "role:architect",
        "none:(none)",
        "reload:reload roles.json, keep \u201cnone\u201d",
      ],
    );
  });

  it("(none) is current when roleless and sends role: null", () => {
    const items = rolePickerItems(["work"], null);
    const none = items.find((i) => i.kind === "none")!;
    expect(none.current).toBe(true);
    expect(none.role).toBeNull();
  });

  it("reload keeps the current role and carries reload semantics", () => {
    const items = rolePickerItems(["work", "architect"], "architect");
    const reload = items.find((i) => i.kind === "reload")!;
    expect(reload.role).toBe("architect");
    expect(reload.current).toBe(false);
  });

  it("no names still yields exactly (none) + reload", () => {
    // roles extension not installed: the picker degrades gracefully
    expect(rolePickerItems([], null).map((i) => i.kind)).toEqual(["none", "reload"]);
  });

  it("blank and duplicate names are dropped defensively", () => {
    expect(rolePickerItems(["work", "", "work"], null).map((i) => i.label)).toEqual([
      "work",
      "(none)",
      "reload roles.json, keep \u201cnone\u201d",
    ]);
  });

  it("the adapter passes roleNames through to the client request", async () => {
    const ui = new UiState();
    const asked: string[] = [];
    (ui.client as unknown as { roleNames: (id: string) => Promise<string[]> }).roleNames = async (
      id: string,
    ) => {
      asked.push(id);
      return ["work"];
    };

    await expect(ui.roleNames("s1")).resolves.toEqual(["work"]);
    expect(asked).toEqual(["s1"]);
  });
});

describe("slash item discovery", () => {
  it("prefixes discovered commands with / and keeps /new and /compact", () => {
    const { ui } = setup();
    (ui.client as unknown as Internals).attachedSessions.set(
      "s1",
      session("s1", {
        commands: [
          { name: "compact" },
          { name: "role", description: "Switch agent role" },
          { name: "skill:review" },
          { name: "review" },
        ],
      }),
    );
    sync(ui);

    expect(ui.slashItems("s1")).toEqual(["/compact", "/new", "/review", "/role", "/skill:review"]);
  });

  it("a sessionState command list replaces the attach list", () => {
    const { ui, c } = setup({ commands: [{ name: "old" }] });
    c.handle({
      type: "proto.sessionState",
      sessionId: "s1",
      role: null,
      model: null,
      thinkingLevel: "off",
      tools: [],
      commands: [{ name: "role" }],
    } as S2C);
    sync(ui);

    expect(ui.commandsOf("s1")).toEqual([{ name: "role" }]);
    expect(ui.slashItems("s1")).toEqual(["/compact", "/new", "/role"]);
  });

  it("no attach → only the client-side commands", () => {
    const ui = new UiState();
    expect(ui.slashItems(null)).toEqual(["/compact", "/new"]);
    expect(ui.slashItems("nope")).toEqual(["/compact", "/new"]);
  });
});
