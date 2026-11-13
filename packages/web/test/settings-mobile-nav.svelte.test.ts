// Below Tailwind's `lg` breakpoint the Settings page's fixed 144px vertical
// rail eats too much of the width (and below `lg` the whole page is rendered
// inside a mobile sheet), so the sections become a horizontally scrolling chip
// strip above the content. The rail itself stays in the DOM (and keeps the
// `nav button` handles the other Settings tests drive); it is just `hidden`
// until `lg`, and the chip strip is `lg:hidden`.
//
// Chips, not a `<Select>`: the strip lives inside a sheet, and a popover listbox
// inside a sheet has to fight it for the bottom of the screen. A chip row is one
// tap, shows every section at once, and never opens a second surface.
//
// happy-dom does no layout, so "hidden below lg / shown from lg up" can only be
// asserted as the class strings the browser will honour.
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

/** The mobile chip strip's wrapper, found by its test hook. */
function mobileWrapper(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-slot="settings-sections-mobile"]');
}

/** The mobile chip strip itself (the scrolling row of section chips). */
function strip(): HTMLElement | null {
  return mobileWrapper()?.querySelector<HTMLElement>('[role="group"]') ?? null;
}

/** The mobile chips, in render order. */
function chips(): HTMLButtonElement[] {
  return [...(strip()?.querySelectorAll<HTMLButtonElement>("button[data-section]") ?? [])];
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

describe("settings mobile section strip", () => {
  it("hides the desktop rail below lg and shows it as a column from lg up", () => {
    stubLoad();
    render();

    const nav = rail();
    expect(nav, "no section nav").not.toBeNull();
    const cls = nav!.className;
    // class pin: happy-dom does no layout, so the responsive behaviour can
    // only be asserted as the classes Tailwind will apply.
    expect(cls).toContain("hidden");
    expect(cls).toContain("lg:flex");
    expect(cls).toContain("flex-col");
    // desktop spacing is untouched
    expect(cls).toContain("w-36");
  });

  it("renders a scrolling chip strip above the content below lg", () => {
    stubLoad();
    render();

    const mobile = mobileWrapper();
    expect(mobile, "no mobile sections wrapper").not.toBeNull();
    // desktop regression: if `lg:hidden` is dropped the strip would show twice
    expect(mobile!.className).toContain("lg:hidden");
    // and it is not the rail: the mobile wrapper is a plain div, not a nav
    expect(mobile!.closest("nav")).toBeNull();

    const row = strip();
    expect(row, "no chip strip").not.toBeNull();
    // one scroller, so a narrow phone never widens the page
    expect(row!.className).toContain("overflow-x-auto");
    expect(row!.className).toContain("overscroll-x-contain");
  });

  it("offers all six sections as touch-sized chips", () => {
    stubLoad();
    render();

    const els = chips();
    expect(els.map((el) => (el.textContent ?? "").trim())).toEqual(LABELS);
    // a finger, not a cursor: every chip clears the 44px floor
    expect(els.every((el) => el.className.includes("min-h-11"))).toBe(true);
    expect(els.every((el) => el.className.includes("shrink-0"))).toBe(true);
  });

  it("picking a chip drives the same `section` state the rail drives", async () => {
    stubLoad();
    render();
    await settle();

    // the default is marked before anything is tapped
    expect(
      chips()
        .find((c) => c.dataset.section === "general")
        ?.getAttribute("aria-current"),
    ).toBe("page");

    chips()
      .find((c) => c.dataset.section === "skills")!
      .click();
    flushSync();
    await settle();

    expect(
      chips()
        .find((c) => c.dataset.section === "skills")
        ?.getAttribute("aria-current"),
    ).toBe("page");
    expect(
      chips()
        .find((c) => c.dataset.section === "general")
        ?.getAttribute("aria-current"),
    ).toBeNull();
    // the rail agrees: it marks the same section current
    const current = rail()!.querySelector('[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe("Skills");
  });

  it("opens no second surface: the strip is not a listbox", () => {
    stubLoad();
    render();

    // the old `<Select>` portalled a listbox over the sheet; a chip row must not
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
