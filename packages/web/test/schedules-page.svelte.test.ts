// Schedules page UI: which cards render, what they show, and what the actions do.
//
// Same adapter-driven setup as skills-page.svelte.test.ts: the component reads
// the shared `ui` singleton, so the mirrors are seeded directly and the command
// wrappers are spied on — no socket, no protocol traffic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import SchedulesPage from "../src/components/SchedulesPage.svelte";
import { ui } from "../src/lib/state.svelte.js";
import type { Schedule, ScheduleInput } from "@uipi/protocol";

const MINUTE = 60_000;

function schedule(over: Partial<Schedule> = {}): Schedule {
  const now = Date.now();
  return {
    id: "sch-1",
    name: "nightly",
    cron: "0 3 * * *",
    prompt: "Summarize the repo",
    role: null,
    cwd: "/proj",
    enabled: true,
    nextRunAt: now + 12 * MINUTE,
    lastRunAt: null,
    history: [],
    ...over,
  };
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SchedulesPage, { target: host });
  flushSync();
  return host;
}

function card(id: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-schedule="${id}"]`);
  if (!el) throw new Error(`no card for ${id}`);
  return el;
}

function action(root: HTMLElement, name: string): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(`button[data-action="${name}"]`);
  if (!el) throw new Error(`no ${name} action`);
  return el;
}

function buttonWithText(text: string): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!el) throw new Error(`no button containing ${text}`);
  return el;
}

function input(id: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`no #${id}`);
  return el;
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

beforeEach(() => {
  ui.schedules = [];
  ui.error = null;
  ui.activeId = null;
  ui.recentDirs = [];
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("schedules page list", () => {
  it("renders one card per schedule with its description, cwd and state", () => {
    ui.schedules = [schedule(), schedule({ id: "sch-2", name: "morning", enabled: false })];
    render();

    expect(host.querySelectorAll("[data-schedule]")).toHaveLength(2);
    const text = card("sch-1").textContent ?? "";
    expect(text).toContain("nightly");
    // the description is describeCron's phrase, not a friendlier paraphrase
    expect(text).toContain("daily at 03:00");
    expect(text).toContain("/proj");
    expect(text).toContain("enabled");
    expect(text).toContain("in 12m");
    expect(text).toContain("last never");
    expect(card("sch-2").textContent).toContain("disabled");
  });

  it("shows the role chip only when a role is set", () => {
    ui.schedules = [schedule({ role: "work" }), schedule({ id: "sch-2", name: "plain" })];
    render();

    expect(card("sch-1").textContent).toContain("work");
    expect(card("sch-2").textContent).not.toContain("work");
  });

  it("counts the schedules in the header", () => {
    ui.schedules = [schedule()];
    render();

    expect(host.textContent).toContain("1");
    expect(host.textContent).toContain("schedule");
  });

  it("Refreshes through the adapter", async () => {
    const refresh = vi.spyOn(ui, "refreshSchedules").mockResolvedValue(undefined);
    render();

    buttonWithText("Refresh").click();
    flushSync();
    await Promise.resolve();

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("schedules page actions", () => {
  it("toggling enabled saves the same schedule with the flag flipped", async () => {
    ui.schedules = [schedule()];
    const save = vi.spyOn(ui, "saveSchedule").mockImplementation(async (i: ScheduleInput) => ({
      ...schedule(),
      ...i,
      id: i.id ?? "sch-1",
    }));
    render();

    action(card("sch-1"), "toggle").click();
    flushSync();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ id: "sch-1", enabled: false, name: "nightly" });
  });

  it("Run now calls the adapter and opens that schedule's history", async () => {
    ui.schedules = [schedule()];
    const run = vi.spyOn(ui, "runScheduleNow").mockResolvedValue({
      at: Date.now(),
      status: "ok",
    });
    render();

    action(card("sch-1"), "run").click();
    flushSync();
    await Promise.resolve();
    flushSync();

    expect(run).toHaveBeenCalledWith("sch-1");
    expect(card("sch-1").textContent).toContain("no runs yet");
  });

  it("Delete asks first and only then removes the schedule", async () => {
    ui.schedules = [schedule()];
    const del = vi.spyOn(ui, "deleteSchedule").mockResolvedValue(undefined);
    render();

    action(card("sch-1"), "delete").click();
    flushSync();
    expect(del).not.toHaveBeenCalled();
    // the confirmation names the schedule
    expect(document.body.textContent).toContain("Delete schedule nightly?");

    document.querySelector<HTMLButtonElement>('button[data-action="confirm-delete"]')!.click();
    flushSync();
    await Promise.resolve();

    expect(del).toHaveBeenCalledWith("sch-1");
  });

  it("Edit loads the schedule into the form and saves it back by id", async () => {
    ui.schedules = [schedule()];
    const save = vi.spyOn(ui, "saveSchedule").mockImplementation(async (i: ScheduleInput) => ({
      ...schedule(),
      ...i,
      id: i.id ?? "sch-1",
    }));
    render();

    action(card("sch-1"), "edit").click();
    flushSync();
    expect(input("schedule-name").value).toBe("nightly");
    expect(input("schedule-cron").value).toBe("0 3 * * *");

    type(input("schedule-name"), "renamed");
    buttonWithText("Save").click();
    flushSync();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ id: "sch-1", name: "renamed" });
  });
});

describe("schedules page form", () => {
  it("presets fill the cron input with honest labels", () => {
    render();

    buttonWithText("New").click();
    flushSync();

    buttonWithText("Weekdays at 08:30").click();
    flushSync();
    expect(input("schedule-cron").value).toBe("30 8 * * 1-5");

    buttonWithText("Every 15 minutes").click();
    flushSync();
    expect(input("schedule-cron").value).toBe("*/15 * * * *");

    buttonWithText("Monthly on the 1st at 00:00").click();
    flushSync();
    expect(input("schedule-cron").value).toBe("0 0 1 * *");
  });

  it("blocks a save with empty fields and says which ones", async () => {
    const save = vi.spyOn(ui, "saveSchedule");
    render();

    buttonWithText("New").click();
    flushSync();
    buttonWithText("Save").click();
    flushSync();

    expect(save).not.toHaveBeenCalled();
    const text = host.textContent ?? "";
    expect(text).toContain("name is required");
    expect(text).toContain("cron is required");
    expect(text).toContain("prompt is required");
    expect(text).toContain("cwd is required");
  });

  it("surfaces the server's own message when a save throws", async () => {
    vi.spyOn(ui, "saveSchedule").mockRejectedValue(
      new Error("cron is not a valid 5-field expression"),
    );
    render();

    buttonWithText("New").click();
    flushSync();
    type(input("schedule-name"), "nightly");
    type(input("schedule-cron"), "nope");
    type(input("schedule-prompt"), "do things");
    type(input("schedule-cwd"), "/proj");
    buttonWithText("Save").click();
    flushSync();
    await Promise.resolve();
    flushSync();

    expect(host.textContent).toContain("cron is not a valid 5-field expression");
  });
});

describe("schedules page history", () => {
  it("lists runs newest first with status, error text and an Open action", async () => {
    const older = Date.now() - 3 * 60 * MINUTE;
    const newer = Date.now() - MINUTE;
    ui.schedules = [
      schedule({
        history: [
          // deliberately out of order: the page sorts newest first itself
          { at: older, status: "error", error: "no API key", sessionFile: "/tmp/a.jsonl" },
          { at: newer, status: "ok", sessionFile: "/tmp/b.jsonl" },
        ],
      }),
    ];
    render();

    action(card("sch-1"), "history").click();
    flushSync();

    const rows = [...card("sch-1").querySelectorAll("div.flex.items-start")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("ok");
    expect(rows[1].textContent).toContain("error");
    expect(rows[1].textContent).toContain("no API key");
    expect(card("sch-1").querySelectorAll('button[data-action="open-run"]')).toHaveLength(2);
  });

  it("Open opens the run's session file, then navigates to the chat", async () => {
    ui.schedules = [
      schedule({ history: [{ at: Date.now(), status: "ok", sessionFile: "/tmp/b.jsonl" }] }),
    ];
    const open = vi.spyOn(ui, "openSession").mockResolvedValue(undefined);
    const go = vi.spyOn(ui, "goToSessionsPage").mockImplementation(() => {});
    render();

    action(card("sch-1"), "history").click();
    flushSync();
    action(card("sch-1"), "open-run").click();
    flushSync();
    await Promise.resolve();

    expect(open).toHaveBeenCalledWith("/tmp/b.jsonl");
    expect(go).toHaveBeenCalledTimes(1);
    // the page route is left alone by syncUrl, so opening must follow navigation
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(go.mock.invocationCallOrder[0]);
  });

  it("a run without a session file gets no Open action", () => {
    ui.schedules = [schedule({ history: [{ at: Date.now(), status: "error", error: "boom" }] })];
    render();

    action(card("sch-1"), "history").click();
    flushSync();

    expect(card("sch-1").querySelector('button[data-action="open-run"]')).toBeNull();
    expect(card("sch-1").textContent).toContain("boom");
  });
});
