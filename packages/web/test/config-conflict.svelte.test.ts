// The lost-write-race signal.
//
// A save echoes the mtime the document was loaded at; if the file changed on
// disk in between, the server answers with a conflict instead of overwriting and
// the client records it in `ui.configConflicts`. The section then has to *tell*
// the user their edits were not written and offer a reload — otherwise the save
// looks like it silently succeeded.
//
// ConfigSection reads `ui.configConflicts` directly and takes its form as a
// `children` snippet, so it is mounted here for real with a stand-in form.
// Driving the state: `ui` is a shared singleton, and the conflict is produced by
// the *client*, not the component — so the test mocks `ui.loadConfig` (seed the
// doc) and `ui.saveConfig` (record the conflict exactly as `recordConfigConflict`
// does), the same seam reload-strip.svelte.test.ts uses. That keeps the
// interesting assertion on markup: what a user with a lost race actually sees.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync, createRawSnippet } from "svelte";
import type { Snippet } from "svelte";
import ConfigSection from "../src/components/settings/ConfigSection.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { ConfigId } from "@uipi/protocol";

type Form = Snippet<[Record<string, unknown>, (next: Record<string, unknown>) => void]>;

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

/**
 * A stand-in for a section's form. It renders the draft it was handed and gives
 * the test a button that makes the draft dirty through the real `set` callback,
 * so the Save button's enabled state behaves as it does in the app.
 */
function standInForm(): Form {
  return createRawSnippet<[Record<string, unknown>, (next: Record<string, unknown>) => void]>(
    (parsed, set) => ({
      render: () => `<div data-form><button data-dirty type="button">edit</button></div>`,
      setup: (el) => {
        el.querySelector<HTMLButtonElement>("[data-dirty]")!.addEventListener("click", () =>
          set()({ theme: "dark" }),
        );
        // read the draft getter so the parsed document is exercised at mount
        void parsed();
      },
    }),
  ) as unknown as Form;
}

/** Mirrors the client: a load stores the doc and supersedes any older conflict. */
function stubLoad(text = '{ "theme": "light" }'): void {
  vi.spyOn(ui, "loadConfig").mockImplementation(async (id: ConfigId) => {
    ui.configDocs.set(id, { docId: id, mtimeMs: 1, text });
    ui.configConflicts.delete(id);
  });
}

function render(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ConfigSection, {
    target: host,
    props: { docId: "settings", children: standInForm() },
  });
  flushSync();
}

function button(label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(el, `no button labelled ${label}`).toBeDefined();
  return el!;
}

/** Let the section's onMount load settle, then repaint. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

/**
 * The banner has no test hook, so find the innermost element that carries its
 * copy — that is the banner block (the warning span's parent div).
 */
function banner(): HTMLElement | null {
  const marker = [...host.querySelectorAll<HTMLElement>("span")].find((s) =>
    s.textContent?.includes("changed on disk"),
  );
  return marker?.parentElement ?? null;
}

beforeEach(() => {
  // shared singleton: reset everything this file touches
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

describe("config section conflict banner", () => {
  it("no conflict means no banner", async () => {
    stubLoad();
    render();
    await settle();

    expect(banner()).toBeNull();
    expect(host.textContent).not.toContain("changed on disk");
    // the stand-in form did render inside the section
    expect(host.querySelector("[data-form]")).not.toBeNull();
  });

  it("a save that loses the mtime race shows the banner and keeps the edit", async () => {
    stubLoad();
    vi.spyOn(ui, "saveConfig").mockImplementation(async () => {
      // what the client does on a proto.configConflict reply: record the race,
      // leave the stored (dirty) doc untouched
      ui.configConflicts.set("settings", { mtimeMs: 2, text: '{ "theme": "afresh" }' });
    });
    render();
    await settle();
    expect(banner()).toBeNull();

    button("edit").click();
    flushSync();
    button("Save").click();
    await settle();

    expect(ui.saveConfig).toHaveBeenCalledWith("settings", expect.stringContaining("dark"));
    const shown = banner()!;
    expect(shown.textContent).toContain("This document changed on disk since it was loaded");
    expect(shown.textContent).toContain("your edits were not written");
    // the affordance, not just the warning
    expect(button("Reload from disk")).toBeDefined();
    // the draft survived the failed save, so nothing the user typed is lost
    expect(host.textContent).toContain("unsaved changes");
    // and a failed save must not claim a reload strip is on offer
    expect(host.querySelector("[data-reload-strip]")).toBeNull();
  });

  it("Reload from disk re-reads the document and clears the banner", async () => {
    // the load mirrors the client: storing a doc supersedes an older conflict
    stubLoad();
    const onDisk = '{ "theme": "afresh" }';
    vi.spyOn(ui, "saveConfig").mockImplementation(async () => {
      ui.configConflicts.set("settings", { mtimeMs: 2, text: onDisk });
    });
    render();
    await settle();

    // a conflict only arises from a lost save — a load clears it
    button("edit").click();
    flushSync();
    button("Save").click();
    await settle();
    expect(banner()).not.toBeNull();

    // the reload reads the version that won the race
    vi.mocked(ui.loadConfig).mockImplementation(async (id: ConfigId) => {
      ui.configDocs.set(id, { docId: id, mtimeMs: 2, text: onDisk });
      ui.configConflicts.delete(id);
    });
    button("Reload from disk").click();
    await settle();

    // the section asked for a fresh read rather than trusting its buffer
    expect(ui.loadConfig).toHaveBeenCalledTimes(2);
    expect(banner()).toBeNull();
    // the reload seeded the buffer with what is on disk, so the form is clean
    expect(host.textContent).not.toContain("unsaved changes");
  });

  it("another document's conflict leaves this section alone", async () => {
    stubLoad();
    ui.configConflicts.set("roles", { mtimeMs: 2, text: "{}" });
    render();
    await settle();

    expect(banner()).toBeNull();
  });
});
