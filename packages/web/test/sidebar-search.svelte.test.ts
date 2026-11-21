// Sidebar session filter: one compact input above the scrolling list narrows
// the rows as the user types. Empty query means no filtering at all, and the
// surviving rows keep the sidebar's newest-first order.
//
// Mount-based, same shared-`ui`-singleton setup as sidebar-order.svelte.test.ts:
// the client calls are spied, so no socket is involved.
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

/** the session rows currently rendered, in render order */
function rows(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button[data-session]")];
}

function rowIds(): string[] {
  return rows().map((r) => r.getAttribute("data-session") ?? "");
}

function searchBox(): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>('input[aria-label="Filter sessions"]');
  if (!found) throw new Error("no filter input");
  return found;
}

/** type into the filter box the way a user would, then let runes settle */
function type(value: string) {
  const input = searchBox();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

/** three sessions across two projects, newest first */
function seed() {
  ui.sessions = [
    summary({
      sessionId: "a1",
      sessionFile: "/tmp/a1.jsonl",
      displayName: "uipi build fix",
      firstMessage: "make the build green",
      mtime: 300,
    }),
    summary({
      sessionId: "a2",
      sessionFile: "/tmp/a2.jsonl",
      displayName: "uipi docs",
      firstMessage: "write some prose",
      mtime: 200,
    }),
    summary({
      sessionId: "b1",
      sessionFile: "/tmp/b1.jsonl",
      displayName: "other thing",
      firstMessage: "unrelated chatter",
      mtime: 100,
      cwd: OTHER,
    }),
  ];
}

describe("sidebar session filter", () => {
  it("renders a compact filter input and shows every session when empty", () => {
    seed();
    render();

    expect(searchBox().placeholder).toContain("Filter sessions");
    expect(searchBox().value).toBe("");
    expect(rowIds()).toEqual(["a1", "a2", "b1"]);
  });

  it("filters to matching rows", () => {
    seed();
    render();

    type("docs");

    expect(rowIds()).toEqual(["a2"]);
  });

  it("matches on cwd", () => {
    seed();
    render();

    type("program/other");

    expect(rowIds()).toEqual(["b1"]);
  });

  it("matches on firstMessage", () => {
    seed();
    render();

    type("chatter");

    expect(rowIds()).toEqual(["b1"]);
  });

  it("matches on the active role", () => {
    ui.sessions = [
      summary({
        sessionId: "a1",
        sessionFile: "/tmp/a1.jsonl",
        displayName: "plain row",
        mtime: 200,
      }),
      summary({
        sessionId: "a2",
        sessionFile: "/tmp/a2.jsonl",
        displayName: "roled row",
        mtime: 100,
        role: "reviewer",
      }),
    ];
    render();

    type("review");

    expect(rowIds()).toEqual(["a2"]);
  });

  it("matches case-insensitively and trims the query", () => {
    seed();
    render();

    type("  DOCS  ");

    expect(rowIds()).toEqual(["a2"]);
  });

  it("treats an all-whitespace query as empty", () => {
    seed();
    render();

    type("   ");

    expect(rowIds()).toEqual(["a1", "a2", "b1"]);
  });

  it("requires every term to match: 'uipi build' skips a row with only uipi", () => {
    seed();
    render();

    type("uipi build");

    // a2 matches "uipi" alone and must not survive the AND
    expect(rowIds()).toEqual(["a1"]);
  });

  it("keeps the newest-first order among the matches", () => {
    seed();
    render();

    type("uipi");

    // both uipi rows match; a1 is newer than a2
    expect(rowIds()).toEqual(["a1", "a2"]);
  });

  it("renders the empty-result text when nothing matches", () => {
    seed();
    render();

    type("nothing-matches-this");

    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("no sessions match");
    expect(host.textContent).not.toContain("no sessions yet");
  });

  it("keeps 'no sessions yet' with no sessions and no query", () => {
    render();

    expect(host.textContent).toContain("no sessions yet");
    expect(host.textContent).not.toContain("no sessions match");
  });

  it("clearing the query restores the full list", () => {
    seed();
    render();

    type("docs");
    expect(rowIds()).toEqual(["a2"]);

    type("");

    expect(rowIds()).toEqual(["a1", "a2", "b1"]);
  });
});

// The active session obeys the filter like any other row: a query that excludes
// it takes it off the list, and there is no separate pinned copy to keep around.
describe("sidebar filter and the active session", () => {
  it("keeps the active row in its place when it matches", () => {
    seed();
    ui.activeId = "a1";
    render();

    type("uipi");

    expect(rowIds()).toEqual(["a1", "a2"]);
    expect(rowIds().filter((id) => id === "a1")).toHaveLength(1);
  });

  it("hides the active row when the query excludes it", () => {
    seed();
    ui.activeId = "a1";
    render();

    type("docs");

    expect(rowIds()).toEqual(["a2"]);
  });
});
