// Phone/tablet layout contract.
//
// happy-dom does no layout, so "this is usable on a phone" is asserted as the
// pieces that make it usable: which container owns the scroll, which controls
// collapse, and that both layouts drive the *same* state. Class pins are the
// honest tool here — they are what Tailwind will apply — and each pin names the
// regression it prevents.
//
// Two invariants:
//   1. Never a fixed side rail on a narrow screen. Settings, skills and roles
//      put their list in a horizontal strip above the form below `lg`; only at
//      `lg` and up is it a rail.
//   2. Never a horizontally scrolling *page*. Scroll strips must declare
//      `basis-0` (or live inside a shrinkable box): an `auto` basis lets a
//      strip's min-content width set the page's min-content width, and a mobile
//      browser then widens the layout viewport past the device.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import App from "../src/App.svelte";
import SettingsPage from "../src/components/SettingsPage.svelte";
import SkillsSection from "../src/components/settings/SkillsSection.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { AttachedSession } from "@uipi/client";
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

function render(page: typeof SettingsPage | typeof SkillsSection): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(page as typeof SettingsPage, { target: host });
  flushSync();
}

/**
 * happy-dom's default viewport is 1024x768, i.e. exactly this app's `lg`
 * breakpoint — on the desktop side. A phone test has to say so, and the app
 * reads it through `MediaQuery`, which listens for `resize`.
 */
function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
  flushSync();
}

/** Mount the real app on `/` with the socket stubbed out, at phone width. */
function renderApp(path = "/"): void {
  setViewport(390);
  history.replaceState(null, "", path);
  vi.spyOn(ui.client, "attach").mockImplementation(() => {});
  ui.init();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(App, { target: host });
  flushSync();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

/** A settings section row in the desktop rail. */
function railRow(label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("nav button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  )!;
}

/** The settings page's scrolling content pane (the only `overflow-y-auto` there). */
function pane(): HTMLElement {
  return [...host.querySelectorAll<HTMLElement>("div")].find(
    (el) => el.className.includes("overflow-y-auto") && el.className.includes("flex-1"),
  )!;
}

function attached(over: Partial<AttachedSession> = {}): AttachedSession {
  return {
    sessionId: "s1",
    model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    thinkingLevel: "high",
    tools: [],
    role: "architect",
    commands: [],
    statuses: {},
    cwd: "/Users/hampus/program/uipi",
    isStreaming: false,
    steering: [],
    followUp: [],
    sessionFile: "/tmp/s1.jsonl",
    messages: [],
    events: [],
    ...over,
  } as AttachedSession;
}

beforeEach(() => {
  ui.configDocs.clear();
  ui.configConflicts.clear();
  ui.skills = [];
  ui.skillsCwd = "/proj";
  ui.error = null;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
  ui.configDocs.clear();
  ui.configConflicts.clear();
  vi.restoreAllMocks();
});

describe("settings page on a phone", () => {
  it("stacks the section picker above a full-width content pane", () => {
    stubLoad();
    render(SettingsPage);

    // the shell is a column below md and a row from md up; without the column
    // the 144px rail would sit beside the form and squeeze it
    const shell = host.firstElementChild!;
    expect(shell.className).toContain("flex-col");
    expect(shell.className).toContain("lg:flex-row");

    // exactly one scroller, and it is the content pane
    const scroller = pane();
    expect(scroller, "no scrollable settings pane").toBeDefined();
    expect(scroller.className).toContain("min-h-0");
  });

  it("resets the pane's scroll when the section changes", async () => {
    stubLoad({ roles: '{ "roles": { "work": {} } }' });
    render(SettingsPage);
    await settle();

    const el = pane();
    // a phone-sized scroll position, as if the previous section were long
    el.scrollTop = 480;
    railRow("Skills").click();
    flushSync();

    // jumping to a short section must not land halfway down it
    expect(el.scrollTop).toBe(0);
  });

  it("keeps the roles rail off narrow screens and uses a scroll strip until lg", async () => {
    stubLoad({
      roles: '{ "roles": { "work": { "description": "a" }, "architect": { "description": "b" } } }',
    });
    render(SettingsPage);
    await settle();
    railRow("Roles").click();
    // the section mounts its own ConfigSection, which loads before it renders
    await settle();

    const rows = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
      b.className.includes("max-lg:shrink-0"),
    );
    expect(rows, "role rows did not render").toHaveLength(2);

    const strip = rows[0].parentElement!;
    // one list, two layouts: a row scroller below lg, a 160px column rail at lg
    expect(strip.className).toContain("max-lg:flex-row");
    expect(strip.className).toContain("max-lg:overflow-x-auto");
    expect(strip.className).toContain("lg:w-40");
    // and the rail must not exist as a fixed width below lg
    expect(strip.className).not.toContain("max-md:w-40");
    expect(strip.className).not.toContain("md:w-40");

    // every row is a touch-sized chip while it is a strip
    expect(rows.every((r) => r.className.includes("max-lg:min-h-11"))).toBe(true);
    expect(strip.getAttribute("aria-label")).toBe("Roles");
  });
});

describe("skills section on a phone", () => {
  it("puts the skill list in a scroll strip above the editor until lg", async () => {
    ui.skills = [
      { name: "review", description: "review a diff", scope: "user" },
      { name: "deploy", description: "ship it", scope: "project" },
    ];
    vi.spyOn(ui, "readSkill").mockResolvedValue({
      frontmatter: "name: review\ndescription: review a diff",
      body: "Do the review.\n",
    });
    render(SkillsSection);
    flushSync();

    const list = host.querySelector<HTMLElement>('[role="group"][aria-label="Skills"]')!;
    expect(list, "no skill list").not.toBeNull();
    // one strip below lg, a scrollable rail from lg up
    expect(list.className).toContain("max-lg:flex-row");
    expect(list.className).toContain("max-lg:overflow-x-auto");
    expect(list.className).toContain("lg:overflow-y-auto");

    // every row is a touch-sized chip below lg
    const rows = [...list.querySelectorAll<HTMLButtonElement>("button[data-skill]")];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.className.includes("max-lg:min-h-11"))).toBe(true);
  });

  it("stacks the list above the editor instead of pinning a rail beside it", () => {
    render(SkillsSection);

    // the section is a column until lg: list strip, then form
    const shell = host.firstElementChild!;
    expect(shell.className).toContain("flex-col");
    expect(shell.className).toContain("lg:flex-row");
    // the height pin only applies where the rail exists, so the section can
    // grow under the page scroller on a phone
    expect(shell.className).toContain("lg:h-full");
    expect(shell.className).not.toContain(" h-full");
  });
});

describe("app chrome on a phone", () => {
  function header(): HTMLElement {
    return host.querySelector("header")!;
  }

  /** The session controls' scroll strip (the pickers live inside it). */
  function controlStrip(): HTMLElement {
    return header().querySelector<HTMLElement>('[aria-label="Session controls"]')!;
  }

  /** Attach one session and let the adapter mirror it, as a real attach would. */
  function attachOne(over: Partial<AttachedSession> = {}): void {
    (
      ui.client as unknown as { attachedSessions: Map<string, AttachedSession> }
    ).attachedSessions.set("s1", attached(over));
    (ui.client as unknown as { activeId: string | null }).activeId = "s1";
    renderApp("/");
    (ui as unknown as { sync: () => void }).sync();
    flushSync();
  }

  it("has no tab strip: pages live in the views sheet, not a sideways scroller", () => {
    attachOne();

    // A 390px row cannot hold four tabs *and* the session chips. Rather than
    // making either a gesture, the tabs become one sheet opened from the title
    // bar — so the only horizontal scroller left in the chrome is the chips.
    expect(header().querySelector('[role="tablist"]')).toBeNull();
    expect(
      header().querySelector('button[aria-label="Views and settings"]'),
      "no views trigger",
    ).not.toBeNull();
    expect(
      header().querySelector('button[aria-label="Sessions"]'),
      "no sessions drawer trigger",
    ).not.toBeNull();
  });

  it("keeps Stop outside the picker scroller so it cannot scroll out of reach", () => {
    attachOne({ isStreaming: true });
    // the run state the header reads is the adapter's mirror, not `isStreaming`
    ui.runState.set("s1", "streaming");
    flushSync();

    const strip = controlStrip();
    expect(strip, "no session control strip").toBeDefined();
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.className).toContain("min-w-0");

    const stop = [...header().querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "Stop",
    );
    expect(stop, "no Stop button while streaming").toBeDefined();
    expect(strip.contains(stop!)).toBe(false);
    expect(header().contains(stop!)).toBe(true);
  });

  it("puts the session chips on their own line under the title bar", () => {
    attachOne();

    const strip = controlStrip();
    const pickers = [...strip.querySelectorAll("button")];
    expect(pickers.length).toBeGreaterThanOrEqual(3);

    // the strip is its own row below the title row, so the title is never
    // squeezed by a model id the width of the screen
    const titleRow = strip.parentElement!.previousElementSibling!;
    expect(titleRow.className).toContain("flex");
    expect(header().contains(titleRow)).toBe(true);
  });

  it("shows the session identity in the title bar, not a cwd chip row", () => {
    attachOne();
    ui.sessionNames.set("s1", "nightly review");
    flushSync();

    const title = header().querySelector("span.font-semibold");
    expect(title?.textContent?.trim()).toBe("nightly review");
    // and the cwd sits under it, truncated rather than wrapped
    expect(header().textContent).toContain("/Users/hampus/program/uipi");
  });

  it("reserves the top safe area so the header is not under a notch", () => {
    renderApp("/");
    expect(header().className).toContain("env(safe-area-inset-top)");
  });
});
