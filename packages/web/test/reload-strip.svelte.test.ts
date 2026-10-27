// Post-save reload affordance.
//
// pi reads its config at session start, so a save changes the file on disk and
// nothing else: a running agent keeps the old values until it is explicitly told
// to re-read. The UI therefore offers the reload instead of performing it, and
// only where pi can take the new values at all:
//
//  * `settings` / `roles` / skills → a strip: "saved — running sessions still use
//    the old values" + a "Reload sessions" button, cleared by a successful reload
//    or the next save.
//  * `sandbox` / `mcp` → no strip at all, just the muted note that pi reads those
//    files at session start (a new session picks them up). Their protocol has no
//    reload, and the UI must not pretend otherwise.
//
// The real SettingsPage is mounted, so the assertions are about what a user sees
// in the section they saved from, not about a component in isolation.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import SettingsPage from "../src/components/SettingsPage.svelte";
import SkillsSection from "../src/components/settings/SkillsSection.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { ConfigId } from "@uipi/protocol";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function strip(): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-reload-strip]");
}

/** Every server-owned document starts as an empty object unless a test says otherwise. */
function stubDocs(text: Partial<Record<ConfigId, string>> = {}) {
  vi.spyOn(ui, "loadConfig").mockImplementation(async (id: ConfigId) => {
    ui.configDocs.set(id, { docId: id, mtimeMs: 1, text: text[id] ?? "{}" });
  });
  vi.spyOn(ui, "saveConfig").mockImplementation(async (id: ConfigId, next: string) => {
    ui.configDocs.set(id, { docId: id, mtimeMs: 2, text: next });
  });
  vi.spyOn(ui, "reloadConfig").mockResolvedValue(["s1"]);
}

function renderSettings(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SettingsPage, { target: host });
  flushSync();
}
/** Click one of the settings page's own nav rows. */
function openSection(label: string): void {
  [...host.querySelectorAll<HTMLButtonElement>("nav button")]
    .find((b) => b.textContent?.trim() === label)!
    .click();
  flushSync();
}

function button(label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
}

/** Type into a bound input so the section's draft becomes dirty. */
function type(id: string, value: string): void {
  const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

/** Let pending promises resolve, then repaint (mounted sections load onMount). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  ui.configDocs.clear();
  vi.restoreAllMocks();
});

describe("config sections after a save", () => {
  it("settings offers a reload strip naming the sessions that still run old values", async () => {
    stubDocs();
    renderSettings();
    await settle();
    expect(strip()).toBeNull();

    type("settings-theme", "dark");
    button("Save").click();
    await settle();

    const shown = strip()!;
    expect(shown.dataset.reloadStrip).toBe("settings");
    expect(shown.textContent).toContain("saved — running sessions still use the old values");
    expect(shown.textContent).toContain("Reload sessions");
  });

  it("roles offers the strip with what: roles, and a successful reload clears it", async () => {
    stubDocs({ roles: '{ "roles": { "work": {} } }' });
    renderSettings();
    await settle();
    openSection("Roles");
    await settle();

    type("role-description", "does the work");
    button("Save").click();
    await settle();

    expect(strip()?.dataset.reloadStrip).toBe("roles");
    button("Reload sessions").click();
    await settle();

    expect(ui.reloadConfig).toHaveBeenCalledWith("roles");
    // the running sessions now use the saved values, so there is nothing to offer
    expect(strip()).toBeNull();
  });

  it("the next save replaces the strip rather than stacking one on top of it", async () => {
    stubDocs();
    renderSettings();
    await settle();

    type("settings-theme", "dark");
    button("Save").click();
    await settle();
    expect(strip()).not.toBeNull();

    type("settings-theme", "light");
    button("Save").click();
    await settle();

    expect(host.querySelectorAll("[data-reload-strip]")).toHaveLength(1);
  });

  it("sandbox shows no strip, only the muted session-start note", async () => {
    stubDocs();
    renderSettings();
    await settle();
    openSection("Sandbox");
    await settle();

    // the raw JSON editor is the only field; it is already dirty-free, so patch
    // the doc through the same path a keystroke takes
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    area.value = '{ "network": "none" }';
    area.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    button("Save").click();
    await settle();

    // pi reads sandbox.json at session start and cannot take it mid-session, so
    // there is nothing to offer — a note instead of a dead button
    expect(ui.saveConfig).toHaveBeenCalledWith("sandbox", expect.stringContaining("network"));
    expect(strip()).toBeNull();
    expect(host.textContent).toContain("pi reads sandbox.json at session start");
    expect(host.textContent).not.toContain("Reload sessions");
  });

  it("mcp shows no strip, only the muted session-start note", async () => {
    stubDocs();
    renderSettings();
    await settle();
    openSection("MCP");
    await settle();

    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    area.value = '{ "mcpServers": {} }';
    area.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    button("Save").click();
    await settle();

    expect(ui.saveConfig).toHaveBeenCalledWith("mcp", expect.stringContaining("mcpServers"));
    expect(strip()).toBeNull();
    expect(host.textContent).toContain("pi reads mcp.json at session start");
    expect(host.textContent).not.toContain("Reload sessions");
  });
});

describe("skills section after a write", () => {
  function renderSkills(): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SkillsSection, { target: host });
    flushSync();
  }

  it("offers the strip with what: skills after a successful write", async () => {
    ui.skills = [{ name: "review", description: "review a diff", scope: "user" }];
    vi.spyOn(ui, "readSkill").mockResolvedValue({
      frontmatter: "name: review\ndescription: review a diff",
      body: "Do the review.\n",
    });
    const write = vi.spyOn(ui, "writeSkill").mockResolvedValue();
    vi.spyOn(ui, "reloadConfig").mockResolvedValue(["s1"]);

    renderSkills();
    host.querySelector<HTMLButtonElement>('button[data-skill="review"]')!.click();
    await settle();
    expect(strip()).toBeNull();

    button("Save").click();
    await settle();

    expect(write).toHaveBeenCalled();
    const shown = strip()!;
    expect(shown.dataset.reloadStrip).toBe("skills");
    expect(shown.textContent).toContain("saved — running sessions still use the old values");
  });
});
