// Sidebar session filter: one compact input above the scrolling list narrows
// the grouped rows as the user types. Empty query means no filtering at all,
// and a group that still has matches is forced open so results never hide
// behind a collapsed header.
//
// Mount-based, same shared-`ui`-singleton setup as sidebar-groups.svelte.test.ts:
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

function hasHeader(cwd: string): boolean {
  return headers().some((b) => b.getAttribute("data-group") === cwd);
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

/** three sessions across two projects: one uipi group (two rows), one other */
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
    expect(headers()).toHaveLength(2);
    // first group open by default; expand the second to see everything
    header(OTHER).click();
    flushSync();
    expect(rowIds()).toEqual(["a1", "a2", "b1"]);
  });

  it("filters to matching rows and drops groups with no matches", () => {
    seed();
    render();

    type("docs");

    expect(rowIds()).toEqual(["a2"]);
    expect(hasHeader(OTHER)).toBe(false);
    expect(hasHeader(UIPI)).toBe(true);
  });

  it("matches on cwd", () => {
    seed();
    render();

    type("program/other");

    expect(rowIds()).toEqual(["b1"]);
    expect(headers()).toHaveLength(1);
    expect(header(OTHER).getAttribute("title")).toBe(OTHER);
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

    expect(headers()).toHaveLength(2);
    expect(() => header(OTHER)).not.toThrow();
  });

  it("requires every term to match: 'uipi build' skips a row with only uipi", () => {
    seed();
    render();

    type("uipi build");

    // a2 matches "uipi" alone and must not survive the AND
    expect(rowIds()).toEqual(["a1"]);
  });

  it("auto-opens groups while filtering, even one collapsed before typing", () => {
    seed();
    render();

    // the OTHER group starts collapsed; collapse the first group too
    expect(header(OTHER).getAttribute("aria-expanded")).toBe("false");
    header(UIPI).click();
    flushSync();
    expect(header(UIPI).getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);

    type("e");

    // both groups still have matches and are open, so their rows are visible
    expect(header(UIPI).getAttribute("aria-expanded")).toBe("true");
    expect(header(OTHER).getAttribute("aria-expanded")).toBe("true");
    expect(rowIds().sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("shows the number of matching sessions as the group count", () => {
    seed();
    render();

    // unfiltered: uipi has 2
    expect(header(UIPI).textContent).toContain("2");

    type("uipi");

    // both uipi rows match the term "uipi", so the count stays 2
    expect(header(UIPI).textContent).toContain("2");

    type("build");
    expect(header(UIPI).textContent).toContain("1");
  });

  it("renders the empty-result text when nothing matches", () => {
    seed();
    render();

    type("nothing-matches-this");

    expect(headers()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("no sessions match");
    expect(host.textContent).not.toContain("no sessions yet");
  });

  it("keeps 'no sessions yet' with no sessions and no query", () => {
    render();

    expect(host.textContent).toContain("no sessions yet");
    expect(host.textContent).not.toContain("no sessions match");
  });

  it("clearing the query restores the full list and the previous collapse state", () => {
    seed();
    render();

    header(UIPI).click();
    flushSync();
    expect(header(UIPI).getAttribute("aria-expanded")).toBe("false");

    type("docs");
    expect(header(UIPI).getAttribute("aria-expanded")).toBe("true");
    expect(rowIds()).toEqual(["a2"]);

    type("");

    // the manual collapse is back, and the untouched group keeps its default
    expect(header(UIPI).getAttribute("aria-expanded")).toBe("false");
    expect(header(OTHER).getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);
    header(UIPI).click();
    flushSync();
    expect(rowIds()).toEqual(["a1", "a2"]);
    header(OTHER).click();
    flushSync();
    expect(rowIds()).toEqual(["a1", "a2", "b1"]);
  });
});

// The pinned active row obeys the filter: a query that excludes the active
// session takes it (and its caption) off the top like any other row.
describe("sidebar filter and the pinned active session", () => {
  function caption(): HTMLElement | null {
    return host.querySelector<HTMLElement>("[data-active-caption]");
  }

  it("pins the matching active session above the headers", () => {
    seed();
    ui.activeId = "a1";
    render();

    type("uipi");

    expect(caption()).not.toBeNull();
    expect(rowIds()[0]).toBe("a1");
    const first = headers()[0];
    expect(
      rowIds().length > 0 &&
        host
          .querySelector('button[data-session="a1"]')!
          .compareDocumentPosition(first as Element) === Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(true);
    // pinned once, not repeated in the group
    expect(rowIds().filter((id) => id === "a1")).toHaveLength(1);
    expect(header(UIPI).textContent).toContain("1");
  });

  it("hides the pinned row and caption when the query excludes the active session", () => {
    seed();
    ui.activeId = "a1";
    render();

    type("docs");

    expect(rowIds()).toEqual(["a2"]);
    expect(caption()).toBeNull();
  });
});
