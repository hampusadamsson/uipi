// New Session dialog: one writable open state shared by the trigger and the
// dialog, so *every* close route (Esc, overlay click, Cancel) resets
// `ui.wantNew` and the next click on "New" reopens it.
//
// Mount-based, same setup as sidebar.svelte.test.ts: the component reads the
// shared `ui` singleton directly, so `ui.wantNew` is set here exactly the way
// `Sidebar.svelte` and `App.svelte` set it, and the outbound `ui.newSession`
// call is spied so no socket is involved.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import NewSessionModal from "../src/components/NewSessionModal.svelte";
import { ui } from "../src/lib/state.svelte.js";

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(NewSessionModal, { target: host });
  flushSync();
}

/**
 * The dialog is portalled and stays mounted while closed (bits-ui only flips
 * `data-state`), so "open" means present *and* `data-state="open"`.
 */
function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function isOpen(): boolean {
  const el = dialog();
  return el !== null && el.getAttribute("data-state") === "open";
}

/** click the header "New" trigger the way Sidebar.svelte does */
function clickNew(): void {
  ui.wantNew = true;
  flushSync();
}

/** let a resolved/rejected promise and the state it sets settle */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

function field(id: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`#${id}`);
  expect(el, `no input #${id}`).not.toBeNull();
  return el!;
}

function type(id: string, value: string): void {
  const el = field(id);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function button(label: string): HTMLButtonElement {
  const els = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => (b.textContent ?? "").trim() === label,
  );
  expect(els.length, `no button labelled ${label}`).toBeGreaterThan(0);
  return els[els.length - 1]!;
}

/** Esc as bits-ui sees it: a keydown on the document while the dialog is open */
function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  flushSync();
}

beforeEach(() => {
  ui.wantNew = false;
  ui.defaults = { cwd: "/defaults/project", agentDir: "/defaults/agent" };
  ui.recentDirs = [];
  ui.attached.clear();
  ui.runState.clear();
  ui.error = null;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  ui.wantNew = false;
  ui.defaults = null;
  vi.restoreAllMocks();
});

describe("new session dialog open/close", () => {
  it("clicking New opens the dialog", () => {
    render();
    expect(isOpen()).toBe(false);

    clickNew();

    expect(isOpen()).toBe(true);
    expect(document.body.textContent).toContain("Create a pi agent session");
  });

  it("Escape closes the dialog and resets ui.wantNew", () => {
    render();
    clickNew();
    expect(isOpen()).toBe(true);

    pressEscape();

    expect(isOpen()).toBe(false);
    expect(ui.wantNew).toBe(false);
  });

  // the regression: a stale `ui.wantNew === true` makes the next click a no-op
  it("reopens on New after an Escape close", () => {
    render();
    clickNew();
    pressEscape();
    expect(ui.wantNew).toBe(false);

    clickNew();

    expect(isOpen()).toBe(true);
  });

  it("Cancel closes the dialog and resets ui.wantNew", () => {
    render();
    clickNew();
    expect(isOpen()).toBe(true);

    button("Cancel").click();
    flushSync();

    expect(isOpen()).toBe(false);
    expect(ui.wantNew).toBe(false);
  });

  it("closing by overlay click resets ui.wantNew", async () => {
    render();
    clickNew();
    expect(isOpen()).toBe(true);

    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    // bits-ui dismisses on a pointerdown that lands outside the content rect, and
    // debounces the decision by a few ms; jsdom has zero-size rects, so any
    // non-zero coordinate is outside.
    overlay!.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: "mouse",
        clientX: 500,
        clientY: 500,
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    flushSync();

    expect(isOpen()).toBe(false);
    expect(ui.wantNew).toBe(false);
  });
});

describe("new session dialog prefill", () => {
  it("opens prefilled from ui.defaults", () => {
    render();
    clickNew();

    expect(field("cwd").value).toBe("/defaults/project");
    expect(field("agentdir").value).toBe("/defaults/agent");
  });

  it("a cancelled edit does not persist into the next open", () => {
    render();
    clickNew();
    type("cwd", "/typed/project");
    type("agentdir", "/typed/agent");

    button("Cancel").click();
    flushSync();
    clickNew();

    expect(field("cwd").value).toBe("/defaults/project");
    expect(field("agentdir").value).toBe("/defaults/agent");
  });
});

describe("new session dialog create", () => {
  it("create() calls ui.newSession with trimmed values and closes", async () => {
    const created = vi.spyOn(ui, "newSession").mockResolvedValue(undefined);
    render();
    clickNew();
    type("cwd", "  /typed/project  ");
    type("agentdir", "  /typed/agent  ");

    button("Create").click();
    await settle();

    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith("/typed/project", "/typed/agent");
    expect(isOpen()).toBe(false);
    expect(ui.wantNew).toBe(false);
  });
});
