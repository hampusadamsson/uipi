// Below Tailwind's `md` breakpoint the Settings page's fixed 144px vertical
// rail eats too much of the width, so the sections move into a compact Select
// above the content. The rail itself stays in the DOM (and keeps the `nav
// button` handles the other Settings tests drive); it is just `hidden` until
// `md`, and the picker is `md:hidden`.
//
// happy-dom does no layout, so "hidden below md / shown above md" can only be
// asserted as the class strings the browser will honour. The picker is opened
// for real: bits-ui portals the content into document.body, which is why the
// labels are looked up there rather than in `host`.
//
// Mount-based, same client-stubbing seam as settings-collapse.svelte.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import SettingsPage from "../src/components/SettingsPage.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { ConfigId } from "@uipi/protocol";

const LABELS = ["General", "Roles", "Sandbox", "MCP", "Advanced", "Skills"];

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

/** The desktop rail — the only nav landmark on the page, so the only `nav`. */
function rail(): HTMLElement | null {
  return host.querySelector<HTMLElement>("nav");
}

/** The mobile section picker's wrapper, found by its test hook. */
function mobileWrapper(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-slot="settings-sections-mobile"]');
}

/** The mobile section picker, found by its accessible name. */
function trigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Settings section"]');
}

/** Open the picker the way a mouse press does (bits-ui opens on pointerdown). */
function openPicker(): void {
  const btn = trigger();
  expect(btn, "no select trigger with aria-label 'Settings section'").not.toBeNull();
  btn!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  flushSync();
}

/** The portalled listbox entries, in DOM order. */
function pickerItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')];
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
  document.body.innerHTML = "";
  ui.configDocs.clear();
  ui.configConflicts.clear();
  ui.error = null;
  vi.restoreAllMocks();
});

describe("settings mobile section picker", () => {
  it("hides the desktop rail below md and shows it as a column from md up", () => {
    stubLoad();
    render();

    const nav = rail();
    expect(nav, "no section nav").not.toBeNull();
    const cls = nav!.className;
    // class pin: happy-dom does no layout, so the responsive behaviour can
    // only be asserted as the classes Tailwind will apply.
    expect(cls).toContain("hidden");
    expect(cls).toContain("md:flex");
    expect(cls).toContain("flex-col");
    // desktop spacing is untouched
    expect(cls).toContain("w-36");
  });

  it("renders a labelled select trigger above the content", () => {
    stubLoad();
    render();

    const btn = trigger();
    expect(btn, "no select trigger with aria-label 'Settings section'").not.toBeNull();
    expect(btn!.className).toContain("w-full");
    // and it is not the rail: the mobile wrapper is a plain div, not a nav
    expect(btn!.closest("nav")).toBeNull();
    // desktop regression: if `md:hidden` is dropped the picker would show twice
    const mobile = mobileWrapper();
    expect(mobile, "no mobile sections wrapper").not.toBeNull();
    expect(mobile!.className).toContain("md:hidden");
    expect(mobile!.contains(btn!)).toBe(true);
  });

  it("offers all six sections once opened", async () => {
    stubLoad();
    render();
    await settle();

    openPicker();
    // bits-ui portals the listbox out of `host`
    const labels = pickerItems().map((el) => (el.textContent ?? "").trim());
    expect(labels).toEqual(expect.arrayContaining(LABELS));
    expect(labels).toHaveLength(LABELS.length);
  });

  it("picking a section drives the same `section` state the rail drives", async () => {
    stubLoad();
    render();
    await settle();

    // the trigger starts on the default section, by label
    expect((trigger()!.textContent ?? "").trim()).toBe("General");

    openPicker();
    const skills = pickerItems().find((el) => (el.textContent ?? "").trim() === "Skills")!;
    expect(skills, "no Skills item").toBeDefined();
    // items select on pointerdown (bits-ui uses pointerup for touch), so a
    // pointerdown then pointerup is what a click does in a real browser
    skills.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    skills.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    flushSync();
    await settle();

    expect((trigger()!.textContent ?? "").trim()).toBe("Skills");
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull();
    // the rail agrees: it marks the same section current
    const current = rail()!.querySelector('[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe("Skills");
  });
});
