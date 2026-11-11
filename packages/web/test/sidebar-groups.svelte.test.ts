// Sidebar project groups: the server now lists archived sessions from every
// recently-used project, so the sidebar groups rows by `s.cwd` — one collapsible
// header per project, newest project first, rows inside a group in the server's
// order.
//
// Mount-based, same shared-`ui`-singleton setup as sidebar.svelte.test.ts: the
// client calls are spied, so no socket is involved.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Sidebar from "../src/components/Sidebar.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { SessionSummary } from "@uipi/protocol";

const UIPI = "/Users/hampus/program/uipi";
const OTHER = "/Users/hampus/program/other";

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    displayName: "s1",
    firstMessage: "hi",
    mtime: 0,
    live: false,
    cwd: UIPI,
    role: null,
    ...over,
  };
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(props: { onAfterSelect?: () => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Sidebar, { target: host, props });
  flushSync();
  return host;
}

/** the project headers, in render order */
function headers(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button[data-group]")];
}

/** the session rows currently rendered, in render order */
function rows(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button[data-session]")];
}

function header(cwd: string): HTMLButtonElement {
  const found = headers().find((b) => b.getAttribute("data-group") === cwd);
  if (!found) throw new Error(`no group header for ${cwd}`);
  return found;
}

/** the row whose visible text starts with `name` */
function row(name: string): HTMLButtonElement {
  const found = rows().find((b) => (b.textContent ?? "").trim().startsWith(name));
  if (!found) throw new Error(`no sidebar row for ${name}`);
  return found;
}

/** let a rejected/resolved promise and the state it sets settle */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  ui.activeId = null;
  ui.error = null;
  ui.sessions = [];
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("sidebar project groups", () => {
  it("renders one header per project, with basename and session count", () => {
    ui.sessions = [
      summary({
        sessionId: "a1",
        sessionFile: "/tmp/a1.jsonl",
        displayName: "uipi one",
        mtime: 300,
      }),
      summary({
        sessionId: "a2",
        sessionFile: "/tmp/a2.jsonl",
        displayName: "uipi two",
        mtime: 200,
      }),
      summary({
        sessionId: "b1",
        sessionFile: "/tmp/b1.jsonl",
        displayName: "other one",
        mtime: 100,
        cwd: OTHER,
      }),
    ];
    render();

    const hs = headers();
    expect(hs).toHaveLength(2);
    expect(hs[0]?.textContent).toContain("uipi");
    expect(hs[0]?.getAttribute("title")).toBe(UIPI);
    expect(hs[0]?.textContent).toContain("2");
    expect(hs[1]?.textContent).toContain("other");
    expect(hs[1]?.getAttribute("title")).toBe(OTHER);
    expect(hs[1]?.textContent).toContain("1");
  });

  it("orders projects newest first and keeps each group's newest-first order", () => {
    // server order: newest first, interleaved across projects
    ui.sessions = [
      summary({
        sessionId: "b1",
        sessionFile: "/tmp/b1.jsonl",
        displayName: "other new",
        mtime: 500,
        cwd: OTHER,
      }),
      summary({
        sessionId: "a1",
        sessionFile: "/tmp/a1.jsonl",
        displayName: "uipi newer",
        mtime: 400,
      }),
      summary({
        sessionId: "a2",
        sessionFile: "/tmp/a2.jsonl",
        displayName: "uipi older",
        mtime: 100,
      }),
    ];
    render();

    expect(headers().map((h) => h.getAttribute("data-group"))).toEqual([OTHER, UIPI]);
    // the first (newest) group is open by default, so its single row shows
    expect(rows().map((r) => r.getAttribute("data-session"))).toEqual(["b1"]);

    header(UIPI).click();
    flushSync();

    expect(rows().map((r) => r.getAttribute("data-session"))).toEqual(["b1", "a1", "a2"]);
    const labels = rows().map((r) => (r.textContent ?? "").trim());
    expect(labels[1]).toContain("uipi newer");
    expect(labels[2]).toContain("uipi older");
  });

  it("clicking a collapsed header expands it and reveals its rows", () => {
    ui.sessions = [
      summary({
        sessionId: "a1",
        sessionFile: "/tmp/a1.jsonl",
        displayName: "uipi row",
        mtime: 300,
      }),
      summary({
        sessionId: "b1",
        sessionFile: "/tmp/b1.jsonl",
        displayName: "other row",
        mtime: 100,
        cwd: OTHER,
      }),
    ];
    render();

    expect(header(OTHER).getAttribute("aria-expanded")).toBe("false");
    expect(rows().some((r) => r.getAttribute("data-session") === "b1")).toBe(false);

    header(OTHER).click();
    flushSync();

    expect(header(OTHER).getAttribute("aria-expanded")).toBe("true");
    expect(rows().map((r) => r.getAttribute("data-session"))).toContain("b1");
    expect(() => row("other row")).not.toThrow();

    // and toggles back
    header(OTHER).click();
    flushSync();
    expect(header(OTHER).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the active session's project by default and collapses later ones", () => {
    ui.sessions = [
      summary({
        sessionId: "b1",
        sessionFile: "/tmp/b1.jsonl",
        displayName: "other row",
        mtime: 900,
        cwd: OTHER,
      }),
      summary({
        sessionId: "a1",
        sessionFile: "/tmp/a1.jsonl",
        displayName: "uipi row",
        mtime: 500,
      }),
      summary({
        sessionId: "c1",
        sessionFile: "/tmp/c1.jsonl",
        displayName: "third row",
        mtime: 400,
        cwd: "/proj/third",
      }),
    ];
    ui.activeId = "a1";
    render();

    // the newest project is open as the first group, the active session's
    // project is open even though it is not first, and the later one collapses
    expect(header(OTHER).getAttribute("aria-expanded")).toBe("true");
    expect(header(UIPI).getAttribute("aria-expanded")).toBe("true");
    expect(header("/proj/third").getAttribute("aria-expanded")).toBe("false");
    expect(rows().map((r) => r.getAttribute("data-session"))).toEqual(["b1", "a1"]);
  });

  it("still renders exactly one header for a single-project list", () => {
    ui.sessions = [
      summary({ sessionId: "a1", sessionFile: "/tmp/a1.jsonl", displayName: "one", mtime: 200 }),
      summary({ sessionId: "a2", sessionFile: "/tmp/a2.jsonl", displayName: "two", mtime: 100 }),
    ];
    render();

    expect(headers()).toHaveLength(1);
    expect(headers()[0]?.textContent).toContain("uipi");
    expect(rows().map((r) => r.getAttribute("data-session"))).toEqual(["a1", "a2"]);
  });

  it("keeps row clicks attaching live sessions and opening archived ones", async () => {
    const attached: string[] = [];
    const opened: string[] = [];
    vi.spyOn(ui, "attach").mockImplementation(async (id: string) => {
      attached.push(id);
    });
    vi.spyOn(ui, "openSession").mockImplementation(async (file: string) => {
      opened.push(file);
    });
    ui.sessions = [
      summary({
        sessionId: "live1",
        sessionFile: "/tmp/live1.jsonl",
        displayName: "live row",
        mtime: 300,
        live: true,
      }),
      summary({
        sessionId: "arch1",
        sessionFile: "/tmp/arch1.jsonl",
        displayName: "archived row",
        mtime: 200,
      }),
    ];
    render();

    row("live row").click();
    await settle();
    row("archived row").click();
    await settle();

    expect(attached).toEqual(["live1"]);
    expect(opened).toEqual(["/tmp/arch1.jsonl"]);
    expect(ui.error).toBeNull();
  });
});
