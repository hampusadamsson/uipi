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

  it("the row header loads the schedule into the form and saves it back by id", async () => {
    ui.schedules = [schedule()];
    const save = vi.spyOn(ui, "saveSchedule").mockImplementation(async (i: ScheduleInput) => ({
      ...schedule(),
      ...i,
      id: i.id ?? "sch-1",
    }));
    render();

    action(card("sch-1"), "expand").click();
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

  it("has no Edit button any more", () => {
    ui.schedules = [schedule()];
    render();

    expect(host.querySelector('[data-action="expand"]')).not.toBeNull();
    expect(host.querySelector('[data-action="edit"]')).toBeNull();
    expect(buttonWithText("New")).not.toBeNull();
  });
});

describe("schedules page inline editing", () => {
  function editable(): HTMLInputElement {
    return input("schedule-name");
  }

  it("expands the clicked row into the form, inside that same card", () => {
    ui.schedules = [schedule(), schedule({ id: "sch-2", name: "morning" })];
    render();

    action(card("sch-1"), "expand").click();
    flushSync();

    const row = card("sch-1");
    expect(row.querySelector("#schedule-name")).not.toBeNull();
    expect(row.contains(editable())).toBe(true);
    // the form lives in the row, not in a separate card above the list
    expect(host.querySelectorAll("#schedule-name")).toHaveLength(1);
    expect(card("sch-2").querySelector("#schedule-name")).toBeNull();
    // no extra top-of-page form card: one card per schedule and nothing else
    expect(host.querySelectorAll('[data-slot="card"]')).toHaveLength(2);
    expect(editable().closest("[data-schedule]")).toBe(row);
  });

  it("marks the row header as expanded and leaves the other rows collapsed", () => {
    ui.schedules = [schedule(), schedule({ id: "sch-2", name: "morning" })];
    render();

    const header = action(card("sch-1"), "expand");
    // a real button, so Enter/Space come for free
    expect(header.tagName).toBe("BUTTON");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    header.click();
    flushSync();

    expect(action(card("sch-1"), "expand").getAttribute("aria-expanded")).toBe("true");
    expect(action(card("sch-2"), "expand").getAttribute("aria-expanded")).toBe("false");
  });

  it("expanding a second row collapses the first", () => {
    ui.schedules = [schedule(), schedule({ id: "sch-2", name: "morning" })];
    render();

    action(card("sch-1"), "expand").click();
    flushSync();
    action(card("sch-2"), "expand").click();
    flushSync();

    expect(card("sch-1").querySelector("#schedule-name")).toBeNull();
    expect(card("sch-2").querySelector("#schedule-name")).not.toBeNull();
    expect(host.querySelectorAll("#schedule-name")).toHaveLength(1);
    // the first row is back to its summary actions
    expect(card("sch-1").querySelector('button[data-action="toggle"]')).not.toBeNull();
  });

  it("clicking the expanded row again collapses it", () => {
    ui.schedules = [schedule()];
    render();

    action(card("sch-1"), "expand").click();
    flushSync();
    action(card("sch-1"), "expand").click();
    flushSync();

    expect(card("sch-1").querySelector("#schedule-name")).toBeNull();
  });

  it("saving collapses the row back to the summary view", async () => {
    ui.schedules = [schedule()];
    vi.spyOn(ui, "saveSchedule").mockImplementation(async (i: ScheduleInput) => ({
      ...schedule(),
      ...i,
      id: i.id ?? "sch-1",
    }));
    render();

    action(card("sch-1"), "expand").click();
    flushSync();
    type(editable(), "renamed");
    buttonWithText("Save").click();
    flushSync();
    await Promise.resolve();
    flushSync();

    const row = card("sch-1");
    expect(row.querySelector("#schedule-name")).toBeNull();
    expect(row.querySelector('button[data-action="run"]')).not.toBeNull();
    expect(row.textContent).toContain("nightly");
  });

  it("Cancel collapses the row without saving", () => {
    ui.schedules = [schedule()];
    const save = vi.spyOn(ui, "saveSchedule");
    render();

    action(card("sch-1"), "expand").click();
    flushSync();
    type(editable(), "renamed");
    buttonWithText("Cancel").click();
    flushSync();

    expect(save).not.toHaveBeenCalled();
    expect(card("sch-1").querySelector("#schedule-name")).toBeNull();
    expect(card("sch-1").querySelector('button[data-action="toggle"]')).not.toBeNull();
  });

  it("keeps the summary actions out of the clickable header", () => {
    ui.schedules = [schedule({ history: [{ at: Date.now(), status: "ok" }] })];
    render();

    const header = action(card("sch-1"), "expand");
    expect(header.querySelector("button")).toBeNull();
    expect(header.contains(action(card("sch-1"), "run"))).toBe(false);
    expect(header.contains(action(card("sch-1"), "delete"))).toBe(false);

    // the actions still work without opening the editor
    action(card("sch-1"), "history").click();
    flushSync();
    expect(card("sch-1").querySelector("#schedule-name")).toBeNull();
  });

  it("New still opens the top form and creates a schedule", async () => {
    ui.schedules = [schedule()];
    const save = vi.spyOn(ui, "saveSchedule").mockImplementation(async (i: ScheduleInput) => ({
      ...schedule(),
      ...i,
      id: i.id ?? "sch-new",
    }));
    render();

    buttonWithText("New").click();
    flushSync();

    // the new-schedule form is not inside any row card
    const form = editable();
    expect(form.closest("[data-schedule]")).toBeNull();
    type(form, "weekly");
    type(input("schedule-cron"), "0 6 * * 1");
    type(input("schedule-prompt"), "do things");
    type(input("schedule-cwd"), "/proj");
    buttonWithText("Save").click();
    flushSync();
    await Promise.resolve();
    flushSync();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ name: "weekly", cron: "0 6 * * 1" });
    expect(save.mock.calls[0][0].id).toBeUndefined();
    expect(host.querySelector("#schedule-name")).toBeNull();
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
