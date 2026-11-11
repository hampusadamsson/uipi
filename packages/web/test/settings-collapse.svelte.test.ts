// Raw JSON is not what the Sandbox and MCP sections are for — those documents
// are edited by hand rarely enough that dropping a 256px monospace textarea on
// top of the section is a poor first impression. Both editors therefore start
// collapsed behind a "show raw JSON" trigger, and the two toggles are separate
// state: opening one section must not open the other.
//
// General is the odd one out: it already has a Form/Raw swap, so the raw editor
// there is chosen explicitly and simply renders when `generalRaw` is true. That
// is the property tested last — an explicit choice always beats the collapsed
// default, and there is no second trigger that could disagree with the button.
//
// The page is mounted for real; only the client is stubbed, through the same
// `ui.loadConfig` seam config-conflict.svelte.test.ts uses, because every
// section is wrapped in a ConfigSection that loads its document on mount.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import SettingsPage from "../src/components/SettingsPage.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { ConfigId } from "@uipi/protocol";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

/** Mirrors the client: a load stores the document this section will render. */
function stubLoad(docs: Partial<Record<ConfigId, string>> = {}): void {
  vi.spyOn(ui, "loadConfig").mockImplementation(async (id: ConfigId) => {
    const text = docs[id] ?? "{}";
    ui.configDocs.set(id, { docId: id, mtimeMs: 1, text });
    ui.configConflicts.delete(id);
  });
}

function render(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SettingsPage, { target: host });
  flushSync();
}

/** Let ConfigSection's onMount load settle, then repaint. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

/** A button by its exact label. */
function button(label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === label,
    ) ?? null
  );
}

/** The section nav is the only place a section is chosen. */
async function go(section: "General" | "Sandbox" | "MCP"): Promise<void> {
  const nav = [...host.querySelectorAll<HTMLButtonElement>("nav button")].find(
    (b) => (b.textContent ?? "").trim() === section,
  );
  expect(nav, `no nav button for ${section}`).toBeDefined();
  nav!.click();
  await settle();
}

/** The collapsible block that carries this section's heading, if it is collapsed or open. */
function panel(heading: "Sandbox" | "MCP"): HTMLElement | null {
  const title = [...host.querySelectorAll("h2")].find(
    (h) => (h.textContent ?? "").trim() === heading,
  );
  return title?.closest<HTMLElement>("[data-slot=collapsible]") ?? null;
}

/** The raw editor textarea, scoped to one panel. */
function editor(heading: "Sandbox" | "MCP"): HTMLTextAreaElement | null {
  return panel(heading)?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
}

/**
 * Collapsible content is kept mounted but `hidden` while closed (bits-ui), so
 * "collapsed" means the editor is in the DOM but not on screen.
 */
function editorVisible(heading: "Sandbox" | "MCP"): boolean {
  const el = editor(heading);
  return el !== null && el.closest("[hidden]") === null;
}

function state(heading: "Sandbox" | "MCP"): string | null | undefined {
  return panel(heading)?.getAttribute("data-state");
}

/** A section heading, which must stay on screen whatever the editor does. */
function heading(label: "Sandbox" | "MCP" | "General"): HTMLElement | null {
  const el =
    [...host.querySelectorAll<HTMLElement>("h2")].find(
      (h) => (h.textContent ?? "").trim() === label,
    ) ?? null;
  return el !== null && el.closest("[hidden]") === null ? el : null;
}

beforeEach(() => {
  ui.configDocs.clear();
  ui.configConflicts.clear();
  ui.error = null;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  ui.configDocs.clear();
  ui.configConflicts.clear();
  ui.error = null;
  vi.restoreAllMocks();
});

describe("settings raw JSON collapse", () => {
  it("sandbox starts with the editor collapsed and reveals it from its trigger", async () => {
    stubLoad({ sandbox: '{ "sandbox": { "enabled": true } }' });
    render();
    await go("Sandbox");

    expect(state("Sandbox")).toBe("closed");
    expect(editorVisible("Sandbox")).toBe(false);
    expect(button("show raw JSON")!.textContent!.trim()).toBe("show raw JSON");

    button("show raw JSON")!.click();
    flushSync();

    expect(state("Sandbox")).toBe("open");
    expect(editorVisible("Sandbox")).toBe(true);
    const shown = editor("Sandbox")!;
    // the real document, not an empty placeholder
    expect(shown.value).toContain("enabled");
    expect(button("hide raw JSON")!.textContent!.trim()).toBe("hide raw JSON");
  });

  it("mcp starts with the editor collapsed and reveals it from its trigger", async () => {
    stubLoad({ mcp: '{ "mcpServers": { "ctx": { "env": { "TOKEN": "x" } } } }' });
    render();
    await go("MCP");

    expect(state("MCP")).toBe("closed");
    expect(editorVisible("MCP")).toBe(false);

    button("show raw JSON")!.click();
    flushSync();

    expect(state("MCP")).toBe("open");
    expect(editorVisible("MCP")).toBe(true);
    expect(editor("MCP")!.value).toContain("mcpServers");
  });

  it("the two sections collapse independently", async () => {
    stubLoad();
    render();

    await go("Sandbox");
    button("show raw JSON")!.click();
    flushSync();
    expect(state("Sandbox")).toBe("open");

    // switching sections must not carry the open state across
    await go("MCP");
    expect(state("MCP")).toBe("closed");
    expect(editorVisible("MCP")).toBe(false);

    // and the sandbox choice is still its own: reopening it shows an open panel
    await go("Sandbox");
    expect(state("Sandbox")).toBe("open");
    expect(editorVisible("Sandbox")).toBe(true);
  });

  it("keeps the section headings (and MCP server list) visible while collapsed", async () => {
    stubLoad({ mcp: '{ "mcpServers": { "ctx": { "env": { "TOKEN": "x" } } } }' });
    render();

    await go("Sandbox");
    expect(editorVisible("Sandbox")).toBe(false);
    // the heading is outside the collapsed content, so it stays on screen
    expect(heading("Sandbox")).not.toBeNull();
    expect(panel("Sandbox")!.textContent).toContain("Sandbox");

    await go("MCP");
    expect(editorVisible("MCP")).toBe(false);
    expect(heading("MCP")).not.toBeNull();
    // the server list is not part of the collapsed editor area
    expect(host.textContent).toContain("ctx");
    expect(host.textContent).toContain("TOKEN");
  });

  it("general shows the raw editor as soon as Form/Raw is switched to Raw", async () => {
    stubLoad({ settings: '{ "theme": "light" }' });
    render();
    await go("General");

    // no collapsible in General: the raw view has no trigger of its own to disagree with
    expect(host.querySelector("[data-slot=collapsible]")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();

    button("Raw JSON")!.click();
    flushSync();

    const raw = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(raw).not.toBeNull();
    expect(raw.value).toContain("light");
    // still no second trigger that could collapse what the button just opened
    expect(host.querySelector("[data-slot=collapsible]")).toBeNull();
    expect(button("Form")!.textContent!.trim()).toBe("Form");

    // and the swap back hides it again
    button("Form")!.click();
    flushSync();
    expect(host.querySelector("textarea")).toBeNull();
    expect(button("Raw JSON")).not.toBeNull();
  });
});
