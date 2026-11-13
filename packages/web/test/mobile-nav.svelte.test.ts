// Mobile chrome: a phone gets modals, not a squeezed desktop.
//
// The layout rule this file pins: below `lg` there is no rail, no tab strip and
// no popover. Sessions are a drawer, every page is a full-height sheet, and each
// picker is a bottom sheet — all built on the bits-ui Dialog primitive, so they
// inherit the focus trap, Escape, the backdrop and `aria-modal` that a
// hand-rolled overlay forgets.
//
// The second rule is state: the URL still owns *which page* is open. Opening a
// page from the sheet pushes the route, and closing the sheet (Esc, backdrop, X,
// or the back gesture) navigates back to the chat — replacing the history entry,
// so the back gesture cannot reopen what was just dismissed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import App from "../src/App.svelte";
import ModelPicker from "../src/components/ModelPicker.svelte";
import { ui } from "../src/lib/state.svelte.js";
import { isDesktop } from "../src/lib/viewport.svelte.js";
import type { AttachedSession } from "@uipi/client";
import type { ModelInfo } from "@uipi/protocol";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

/** happy-dom defaults to 1024px, i.e. exactly the `lg` breakpoint. */
function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
  flushSync();
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

/** Mount the app at phone width, with one attached session and no socket. */
function renderApp(path = "/", over: Partial<AttachedSession> = {}): void {
  setViewport(390);
  history.replaceState(null, "", path);
  vi.spyOn(ui.client, "attach").mockImplementation(() => {});
  const internals = ui.client as unknown as {
    attachedSessions: Map<string, AttachedSession>;
    activeId: string | null;
  };
  internals.attachedSessions.set("s1", attached(over));
  internals.activeId = "s1";
  ui.init();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(App, { target: host });
  (ui as unknown as { sync: () => void }).sync();
  flushSync();
}

/** the portalled sheet whose accessible title matches */
function sheet(title: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-content"]')].find(
      (el) => (el.querySelector('[data-slot="dialog-title"]')?.textContent ?? "").trim() === title,
    ) ?? null
  );
}

function openSheets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-content"]')].filter(
    (el) => el.getAttribute("data-state") === "open",
  );
}

function header(): HTMLElement {
  return host.querySelector("header")!;
}

function trigger(label: string): HTMLButtonElement {
  const el = header().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no header trigger "${label}"`);
  return el;
}

/** Esc as bits-ui sees it */
function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  flushSync();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

beforeEach(() => {
  ui.error = null;
  ui.wantNew = false;
  ui.models = [];
  ui.sessions = [];
  history.replaceState(null, "", "/");
  ui.page = "sessions";
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
  setViewport(1024);
  vi.restoreAllMocks();
});

describe("mobile chrome", () => {
  it("uses the modal layout below lg and the rail layout from lg up", () => {
    renderApp();
    expect(isDesktop.current).toBe(false);
    // one mobile title bar, no tab strip
    expect(header().querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector("aside")).toBeNull();

    setViewport(1024);
    flushSync();
    // and the desktop chrome comes back in the same mount, state intact
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(host.querySelector("aside")).not.toBeNull();
  });

  it("opens the session list as a left drawer from the title bar", () => {
    renderApp();
    expect(openSheets()).toHaveLength(0);

    trigger("Sessions").click();
    flushSync();

    const drawer = sheet("Sessions");
    expect(drawer, "no sessions drawer").not.toBeNull();
    expect(drawer!.getAttribute("data-side")).toBe("left");
    // the drawer holds the real sidebar, so rows, groups and the filter all
    // keep working — the mobile form of the same component, not a copy
    expect(drawer!.querySelector("aside")).not.toBeNull();
    expect(drawer!.querySelector('input[aria-label="Filter sessions"]')).not.toBeNull();
  });

  it("opens the views sheet from the title bar with every destination", () => {
    renderApp();
    trigger("Views and settings").click();
    flushSync();

    const views = sheet("uipi");
    expect(views, "no views sheet").not.toBeNull();
    const rows = [...views!.querySelectorAll<HTMLElement>("[data-view]")];
    expect(rows.map((r) => r.dataset.view)).toEqual([
      "sessions",
      "skills",
      "schedules",
      "settings",
    ]);
    // every row is a touch target, not a 24px list item
    expect(rows.every((r) => r.className.includes("min-h-14"))).toBe(true);
  });

  it("drills into Settings in the same sheet, with a back chevron to the list", async () => {
    renderApp();
    trigger("Views and settings").click();
    flushSync();

    sheet("uipi")!.querySelector<HTMLElement>('[data-view="settings"]')!.click();
    flushSync();
    await settle();

    // the route moved and the list was replaced in place: one sheet, not two
    expect(ui.page).toBe("settings");
    expect(location.pathname).toBe("/settings");
    expect(openSheets()).toHaveLength(1);
    const pageSheet = sheet("Settings");
    expect(pageSheet, "no settings sheet").not.toBeNull();
    // the page's own sections are in there
    expect(pageSheet!.textContent).toContain("Roles");

    // the chevron returns to the list without closing the sheet
    const back = pageSheet!.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!;
    expect(back, "no back chevron").not.toBeNull();
    back.click();
    flushSync();
    await settle();

    expect(ui.page).toBe("sessions");
    const list = sheet("uipi");
    expect(list, "back did not land on the view list").not.toBeNull();
    expect(list!.querySelectorAll("[data-view]")).toHaveLength(4);
  });

  it("closing a page sheet navigates back to the chat and does not leave history behind", async () => {
    renderApp("/settings");
    await settle();
    expect(openSheets()).toHaveLength(1);

    const before = history.length;
    pressEscape();
    await settle();

    expect(ui.page).toBe("sessions");
    // back on the session's own chat route (there is an attached session)
    expect(location.pathname).not.toContain("settings");
    expect(openSheets()).toHaveLength(0);
    // replaced, not pushed: closing must not add an entry the back gesture
    // would land on (reopening the page just dismissed)
    expect(history.length).toBe(before);
  });

  it("a page opened from the views sheet also closes back to the chat", async () => {
    renderApp();
    trigger("Views and settings").click();
    flushSync();
    sheet("uipi")!.querySelector<HTMLElement>('[data-view="schedules"]')!.click();
    flushSync();
    await settle();
    expect(ui.page).toBe("schedules");

    pressEscape();
    await settle();
    expect(ui.page).toBe("sessions");
    expect(location.pathname).not.toContain("schedules");
  });

  it("asks the sheet to open a session list rather than stacking a second modal", async () => {
    renderApp();
    trigger("Views and settings").click();
    flushSync();

    sheet("uipi")!.querySelector<HTMLElement>('[data-view="sessions"]')!.click();
    flushSync();

    // the sessions row is the drawer, so the navigation sheet is gone and the
    // drawer is up: exactly one modal surface at a time
    const open = openSheets();
    expect(open).toHaveLength(1);
    expect(open[0].getAttribute("data-side")).toBe("left");
  });

  it("gives every sheet a real modal header: title, Escape and a close control", () => {
    renderApp();
    trigger("Views and settings").click();
    flushSync();

    const views = sheet("uipi")!;
    // labelled by the primitive, so screen readers get a name
    expect(views.querySelector('[data-slot="dialog-title"]')).not.toBeNull();
    expect(views.querySelector('[data-slot="dialog-description"]')).not.toBeNull();
    expect(views.querySelector('button[aria-label="Close"]')).not.toBeNull();
    // and the overlay blocks the page behind it
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
  });
});

describe("pickers on a phone", () => {
  it("opens the model list as a sheet, not a popover anchored to a chip", async () => {
    ui.models = Array.from({ length: 30 }, (_, i) => ({
      provider: "p",
      modelId: `m${i}`,
      displayName: `model ${i}`,
      reasoning: false,
      contextWindow: 1000,
    })) as ModelInfo[];
    setViewport(390);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ModelPicker, { target: host, props: { sessionId: "s1" } });
    flushSync();

    host.querySelector<HTMLButtonElement>("button")!.click();
    flushSync();

    const list = sheet("Model");
    expect(list, "no model sheet").not.toBeNull();
    expect(list!.getAttribute("data-side")).toBe("bottom");
    // a real filter field, and its own bounded scroller inside the sheet
    expect(list!.querySelector('[data-slot="command-input"]')).not.toBeNull();
    const rows = list!.querySelector('[data-slot="command-list"]')!;
    expect(rows.className).toContain("max-lg:max-h-[55dvh]");
  });

  it("keeps the popover form from lg up", () => {
    setViewport(1024);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ModelPicker, { target: host, props: { sessionId: "s1" } });
    flushSync();

    host.querySelector<HTMLButtonElement>("button")!.click();
    flushSync();

    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });
});
