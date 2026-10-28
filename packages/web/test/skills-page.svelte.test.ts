// Skills page UI: which cards render, what they show, and what a click does.
//
// Same adapter-driven setup as role.svelte.test.ts, but these assertions are
// about rendered markup, so the component is mounted with `mount` against the
// shared `ui` singleton (the component reads it directly).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import SkillsPage from "../src/components/SkillsPage.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { SkillInfo } from "@uipi/protocol";

const skills: SkillInfo[] = [
  { name: "review", description: "review a diff", scope: "user" },
  { name: "deploy", description: "ship it", scope: "project" },
  { name: "audit", description: "look for holes", scope: "user" },
];

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SkillsPage, { target: host });
  flushSync();
  return host;
}

function cards(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button[data-skill]")];
}

beforeEach(() => {
  ui.skills = [];
  ui.skillsCwd = "/proj";
  ui.recentDirs = [];
  ui.error = null;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("skills page cards", () => {
  it("renders one card per skill, sorted, with names visible", () => {
    ui.skills = skills;
    render();

    const rendered = cards();
    expect(rendered).toHaveLength(3);
    expect(rendered.map((c) => c.dataset.skill)).toEqual(["audit", "deploy", "review"]);
    const text = host.textContent ?? "";
    for (const s of skills) expect(text).toContain(s.name);
    // the header counts them and names the cwd it is scoped to
    expect(text).toContain("/proj");
    expect(text).toContain("3");
  });

  it("marks project-scope skills only", () => {
    ui.skills = skills;
    render();

    const project = cards().find((c) => c.dataset.skill === "deploy")!;
    const user = cards().find((c) => c.dataset.skill === "review")!;
    expect(project.textContent).toContain("project");
    expect(user.textContent).not.toContain("project");
  });

  it("clicking a card starts that skill", async () => {
    ui.skills = skills;
    const started: SkillInfo[] = [];
    vi.spyOn(ui, "startSkill").mockImplementation(async (skill) => {
      started.push(skill as SkillInfo);
    });
    render();

    cards()
      .find((c) => c.dataset.skill === "review")!
      .click();
    flushSync();
    // let the awaited startSkill settle so the busy flag clears again
    await Promise.resolve();
    flushSync();

    expect(started.map((s) => s.name)).toEqual(["review"]);
  });

  it("no cwd renders the hint and disables every card", () => {
    ui.skills = skills;
    ui.skillsCwd = null;
    ui.recentDirs = [];
    render();

    expect(host.textContent).toContain("attach or create a session first");
    const rendered = cards();
    expect(rendered).toHaveLength(3);
    expect(rendered.every((c) => c.disabled)).toBe(true);
  });

  it("a rejected startSkill surfaces an error and leaves the cards enabled", async () => {
    ui.skills = skills;
    vi.spyOn(ui, "startSkill").mockRejectedValue(new Error("server said no"));
    render();

    cards()
      .find((c) => c.dataset.skill === "review")!
      .click();
    flushSync();
    // let the rejected promise settle so pick()'s catch and finally both run
    await Promise.resolve();
    flushSync();

    expect(ui.error).toContain("could not start skill: server said no");
    expect(cards().every((c) => !c.disabled)).toBe(true);
  });

  // Regression guard: this already passes; it guards against reintroducing a
  // session-dependent scope — cards come from the discovered cwd, not a session.
  it("keeps the page usable with no active session when a cwd was discovered", async () => {
    ui.skills = skills;
    ui.skillsCwd = "/proj";
    ui.recentDirs = [];
    ui.activeId = null;
    const started: string[] = [];
    vi.spyOn(ui, "startSkill").mockImplementation(async (skill) => {
      started.push(skill.name);
    });
    render();

    const rendered = cards();
    expect(rendered.every((c) => !c.disabled)).toBe(true);
    expect(host.textContent).toContain("/proj");

    rendered.find((c) => c.dataset.skill === "review")!.click();
    flushSync();
    await Promise.resolve();
    flushSync();

    expect(started).toEqual(["review"]);
  });
});
