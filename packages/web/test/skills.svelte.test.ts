// Skills page plumbing for the Svelte adapter: the skills mirror, the
// `/skills` page route, and `startSkill` (new session in the current cwd, then
// the skill as an ordinary prompt).
//
// Same fake-client style as role.svelte.test.ts: no Svelte mount, only the view
// data contract and the two client calls `startSkill` makes.
import { describe, it, expect } from "vitest";
import { UiState } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { SkillInfo } from "@uipi/protocol";

function session(id: string, cwd = "/proj"): AttachedSession {
  return {
    sessionId: id,
    model: { provider: "p", modelId: "m1" },
    thinkingLevel: "off",
    tools: [],
    role: null,
    commands: [],
    statuses: {},
    cwd,
    isStreaming: false,
    steering: [],
    followUp: [],
    sessionFile: `/tmp/${id}.jsonl`,
    messages: [],
    events: [],
  } as AttachedSession;
}

type Internals = {
  attachedSessions: Map<string, AttachedSession>;
  activeId: string | null;
  recentDirs: string[];
  skills: SkillInfo[];
};

function sync(ui: UiState): void {
  (ui as unknown as { sync: () => void }).sync();
}

/** Build an adapter with one attached session active, mirrors already synced. */
function setup(cwd = "/proj") {
  const ui = new UiState();
  const c = ui.client as unknown as Internals;
  c.attachedSessions.set("s1", session("s1", cwd));
  c.activeId = "s1";
  sync(ui);
  return { ui, c };
}

/** Record the two calls `startSkill` is allowed to make. */
function record(ui: UiState) {
  const calls: { newSession: string[]; sendPrompt: [string, string][] } = {
    newSession: [],
    sendPrompt: [],
  };
  const client = ui.client as unknown as {
    newSession: (cwd: string) => Promise<void>;
    sendPrompt: (id: string, text: string) => void;
  };
  // a new session attaches and becomes active, like the real client does
  client.newSession = async (cwd: string) => {
    calls.newSession.push(cwd);
    const internals = ui.client as unknown as Internals;
    internals.attachedSessions.set("s2", session("s2", cwd));
    internals.activeId = "s2";
    sync(ui);
  };
  client.sendPrompt = (id: string, text: string) => {
    calls.sendPrompt.push([id, text]);
  };
  return calls;
}

describe("skills mirror", () => {
  it("sync mirrors the client's skills and the cwd they belong to", () => {
    const { ui, c } = setup("/proj");
    c.skills = [{ name: "demo", description: "a demo skill", scope: "user" }];
    sync(ui);
    expect(ui.skills.map((s) => s.name)).toEqual(["demo"]);
    expect(ui.skillsCwd).toBe("/proj");
  });
});

describe("startSkill", () => {
  it("opens a session in the active cwd, then prompts with the skill", async () => {
    const { ui } = setup("/proj");
    const calls = record(ui);

    await ui.startSkill({ name: "demo" });

    expect(calls.newSession).toEqual(["/proj"]);
    expect(calls.sendPrompt).toEqual([["s2", "/skill:demo"]]);
  });

  it("falls back to the most recent dir when no session is active", async () => {
    const ui = new UiState();
    const c = ui.client as unknown as Internals;
    c.recentDirs = ["/recent"];
    sync(ui);
    const calls = record(ui);

    await ui.startSkill({ name: "demo" });

    expect(calls.newSession).toEqual(["/recent"]);
    expect(calls.sendPrompt).toEqual([["s2", "/skill:demo"]]);
  });

  it("does nothing when there is neither an active session nor a recent dir", async () => {
    const ui = new UiState();
    const calls = record(ui);

    await ui.startSkill({ name: "demo" });

    expect(calls.newSession).toEqual([]);
    expect(calls.sendPrompt).toEqual([]);
  });
});

describe("skills page routing", () => {
  it("hydrateFromUrl leaves /skills alone instead of rewriting it to /", async () => {
    history.replaceState(null, "", "/skills");
    const ui = new UiState();

    await ui.hydrateFromUrl();

    expect(location.pathname).toBe("/skills");
  });

  it('goToPage("skills") sets the page and pushes /skills', () => {
    history.replaceState(null, "", "/");
    const ui = new UiState();

    ui.goToPage("skills");

    expect(ui.page).toBe("skills");
    expect(location.pathname).toBe("/skills");
  });

  it("goToSessionsPage returns to the active session's path", () => {
    const { ui } = setup("/proj");
    ui.goToPage("skills");

    ui.goToSessionsPage();

    expect(ui.page).toBe("sessions");
    expect(location.pathname).toBe(UiState.pathFor("/tmp/s1.jsonl"));
  });
});
