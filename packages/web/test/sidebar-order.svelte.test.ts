// Sidebar row order: one flat list, newest use first, with no project grouping.
//
// The sidebar used to group rows under a collapsible header per `cwd`. It is a
// "what was I doing" list, so what matters is recency — and the project is
// already on the row itself. These tests pin the flat order and the absence of
// headers, so grouping cannot creep back in.
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

/** the session rows, in render order */
function rows(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button[data-session]")];
}

function rowIds(): string[] {
  return rows().map((r) => r.getAttribute("data-session") ?? "");
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

describe("sidebar row order", () => {
  it("renders no project headers at all", () => {
    ui.sessions = [
      summary({ sessionId: "a1", sessionFile: "/tmp/a1.jsonl", mtime: 300 }),
      summary({ sessionId: "b1", sessionFile: "/tmp/b1.jsonl", mtime: 100, cwd: OTHER }),
    ];
    render();

    expect(host.querySelectorAll("button[data-group]")).toHaveLength(0);
    // no collapse triggers or group captions either
    expect(host.querySelectorAll("[aria-expanded]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-active-caption]")).toHaveLength(0);
    // both rows are on screen at once: nothing can hide them
    expect(rowIds()).toEqual(["a1", "b1"]);
  });

  it("interleaves projects by last use instead of bucketing them", () => {
    // newest first: other, uipi, other — a grouped sidebar would show uipi's
    // rows together and bury the second `other` row under a collapsed header
    ui.sessions = [
      summary({ sessionId: "b1", sessionFile: "/tmp/b1.jsonl", mtime: 500, cwd: OTHER }),
      summary({ sessionId: "a1", sessionFile: "/tmp/a1.jsonl", mtime: 400 }),
      summary({ sessionId: "b2", sessionFile: "/tmp/b2.jsonl", mtime: 300, cwd: OTHER }),
      summary({ sessionId: "a2", sessionFile: "/tmp/a2.jsonl", mtime: 100 }),
    ];
    render();

    expect(rowIds()).toEqual(["b1", "a1", "b2", "a2"]);
  });

  it("sorts by mtime even when the server order is stale", () => {
    ui.sessions = [
      summary({ sessionId: "old", sessionFile: "/tmp/old.jsonl", mtime: 100 }),
      summary({ sessionId: "new", sessionFile: "/tmp/new.jsonl", mtime: 900 }),
      summary({ sessionId: "mid", sessionFile: "/tmp/mid.jsonl", mtime: 500 }),
    ];
    render();

    expect(rowIds()).toEqual(["new", "mid", "old"]);
  });

  it("leaves `ui.sessions` itself in the order the server sent", () => {
    ui.sessions = [
      summary({ sessionId: "old", sessionFile: "/tmp/old.jsonl", mtime: 100 }),
      summary({ sessionId: "new", sessionFile: "/tmp/new.jsonl", mtime: 900 }),
    ];
    render();

    expect(ui.sessions.map((s) => s.sessionId)).toEqual(["old", "new"]);
  });

  it("shows the project path on each row so the folder is still visible", () => {
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

    expect(row("uipi row").textContent).toContain(UIPI);
    expect(row("other row").textContent).toContain(OTHER);
  });

  it("renders the active session once, in place, with no pinned copy", () => {
    ui.sessions = [
      summary({ sessionId: "b1", sessionFile: "/tmp/b1.jsonl", mtime: 900, cwd: OTHER }),
      summary({ sessionId: "a1", sessionFile: "/tmp/a1.jsonl", mtime: 500 }),
      summary({ sessionId: "a2", sessionFile: "/tmp/a2.jsonl", mtime: 400 }),
    ];
    ui.activeId = "a1";
    render();

    expect(rowIds()).toEqual(["b1", "a1", "a2"]);
    expect(rowIds().filter((id) => id === "a1")).toHaveLength(1);
    // it is highlighted in place, which is what "active" means now
    const active = host.querySelector<HTMLButtonElement>('button[data-session="a1"]')!;
    expect(active.className).toContain("bg-accent");
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

  it("renders nothing extra when the list is empty", () => {
    render();

    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("no sessions yet");
  });
});
