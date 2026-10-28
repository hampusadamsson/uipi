// Sidebar session rows: a click on a live row attaches, a click on an archived
// row opens its file, and — the point of these tests — a rejecting switch is not
// a silent dead click: the failure lands on `ui.error`, the same surface App
// toasts.
//
// Mount-based, same adapter-driven setup as skills-page.svelte.test.ts: the
// component reads the shared `ui` singleton directly, and the client calls are
// spied so no socket is involved.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Sidebar from "../src/components/Sidebar.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { SessionSummary } from "@uipi/protocol";

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    displayName: "s1",
    firstMessage: "hi",
    mtime: 0,
    live: false,
    cwd: "/proj",
    role: null,
    ...over,
  };
}

/** one live session and one archived session, distinguishable by their text */
const sessions = [
  summary({
    sessionId: "live1",
    sessionFile: "/tmp/live1.jsonl",
    displayName: "live row",
    live: true,
  }),
  summary({
    sessionId: "arch1",
    sessionFile: "/tmp/arch1.jsonl",
    displayName: "archived row",
    live: false,
  }),
];

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(props: { onAfterSelect?: () => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Sidebar, { target: host, props });
  flushSync();
  return host;
}

/** the sidebar row whose visible text starts with `name` */
function row(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(name),
  );
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
  ui.sessions = sessions;
  ui.error = null;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("sidebar session rows", () => {
  it("clicking a live row attaches that session", async () => {
    const attached: string[] = [];
    vi.spyOn(ui, "attach").mockImplementation(async (id: string) => {
      attached.push(id);
    });
    render();

    row("live row").click();
    await settle();

    expect(attached).toEqual(["live1"]);
    expect(ui.error).toBeNull();
  });

  it("clicking an archived row opens its session file", async () => {
    const opened: string[] = [];
    vi.spyOn(ui, "openSession").mockImplementation(async (file: string) => {
      opened.push(file);
    });
    render();

    row("archived row").click();
    await settle();

    expect(opened).toEqual(["/tmp/arch1.jsonl"]);
    expect(ui.error).toBeNull();
  });

  it("a rejected attach surfaces an error instead of a dead click", async () => {
    vi.spyOn(ui, "attach").mockRejectedValue(new Error("session gone"));
    render();

    row("live row").click();
    await settle();

    expect(ui.error).toContain("could not open session: session gone");
  });

  it("a rejected openSession surfaces an error instead of a dead click", async () => {
    vi.spyOn(ui, "openSession").mockRejectedValue(new Error("server said no"));
    render();

    row("archived row").click();
    await settle();

    expect(ui.error).toContain("could not open session: server said no");
  });

  // Menu-closing behaviour is deliberately unchanged: a live click closes the
  // menu synchronously (today's code calls onAfterSelect without awaiting the
  // attach), an archived click closes it only after openSession succeeds.
  it("keeps the existing onAfterSelect timing on both paths", async () => {
    const afterSelect = vi.fn();
    vi.spyOn(ui, "attach").mockRejectedValue(new Error("boom"));
    vi.spyOn(ui, "openSession").mockRejectedValue(new Error("boom"));
    render({ onAfterSelect: afterSelect });

    row("live row").click();
    await settle();
    expect(afterSelect).toHaveBeenCalledTimes(1);

    row("archived row").click();
    await settle();
    expect(afterSelect).toHaveBeenCalledTimes(1);
  });
});
