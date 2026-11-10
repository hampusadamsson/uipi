// Schedules are server-owned state, so these tests pin the parts a bug would
// silently ruin: id generation and validation on save, the run/history record,
// the 100-entry cap, that a corrupt file degrades to "no schedules" instead of
// crashing the server, and that the timer loop can be started and stopped twice.
//
// Every case uses a mkdtemp directory and an injected clock, so nothing here
// reads or writes the real agent dir and no assertion depends on the wall clock.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule, ScheduleInput, ScheduleRun } from "@uipi/protocol";
import { ScheduleService, type ScheduleRunResult } from "../src/schedules.js";

const dirs: string[] = [];

/** A throwaway directory, removed again in afterEach. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uipi-sched-"));
  dirs.push(dir);
  return dir;
}

/** A minimal valid save input, overridable per case. */
function input(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: "nightly",
    cron: "0 9 * * *",
    prompt: "run the tests",
    role: null,
    cwd: "/tmp/work",
    enabled: true,
    ...over,
  };
}

/** "Now" used by the store, advanced by hand where a case needs time to pass. */
function clock(start: string): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(start);
  return { now: () => new Date(current), set: (iso) => (current = new Date(iso)) };
}

/** A service whose session creation is a stub the test controls. */
function service(opts: {
  dir: string;
  now?: () => Date;
  createRun?: (schedule: Schedule) => Promise<ScheduleRunResult>;
}): ScheduleService {
  return new ScheduleService({
    agentDir: opts.dir,
    now: opts.now,
    createRun: opts.createRun ?? (async () => ({ sessionId: "sess-1" })),
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ScheduleService storage", () => {
  it("creates a schedule with a generated id and writes the file", () => {
    const dir = tempDir();
    const svc = service({ dir, now: clock("2024-03-01T08:00:00").now });

    const created = svc.save(input());

    expect(created.id).toBeTruthy();
    expect(created.history).toEqual([]);
    expect(created.lastRunAt).toBeNull();
    expect(created.nextRunAt).toBe(new Date(2024, 2, 1, 9, 0, 0).getTime());
    expect(svc.list()).toEqual([created]);

    const path = join(dir, "schedules.json");
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { schedules: Schedule[] };
    expect(onDisk.schedules).toEqual([created]);
  });

  it("lists schedules sorted by name and updates in place", () => {
    const dir = tempDir();
    const svc = service({ dir, now: clock("2024-03-01T08:00:00").now });

    svc.save(input({ name: "zeta" }));
    const alpha = svc.save(input({ name: "alpha" }));

    expect(svc.list().map((s) => s.name)).toEqual(["alpha", "zeta"]);

    const updated = svc.save(input({ id: alpha.id, name: "aardvark", cron: "30 7 * * *" }));
    expect(updated.id).toBe(alpha.id);
    expect(svc.list().map((s) => s.name)).toEqual(["aardvark", "zeta"]);
    expect(svc.list()).toHaveLength(2);
  });

  it("reloads what it saved (a fresh service sees the same schedules)", () => {
    const dir = tempDir();
    const now = clock("2024-03-01T08:00:00").now;
    const first = service({ dir, now });
    const saved = first.save(input({ name: "beta" }));

    expect(service({ dir, now }).list()).toEqual([saved]);
  });

  it("throws when saving an unknown id", () => {
    const svc = service({ dir: tempDir(), now: clock("2024-03-01T08:00:00").now });
    expect(() => svc.save(input({ id: "nope" }))).toThrow(/unknown schedule id/);
  });

  it("rejects empty name, prompt and cwd and an invalid cron", () => {
    const svc = service({ dir: tempDir(), now: clock("2024-03-01T08:00:00").now });

    expect(() => svc.save(input({ name: "" }))).toThrow(/schedule name must not be empty/);
    expect(() => svc.save(input({ prompt: "  " }))).toThrow(/schedule prompt must not be empty/);
    expect(() => svc.save(input({ cwd: "" }))).toThrow(/schedule cwd must not be empty/);
    expect(() => svc.save(input({ cron: "0 9 * *" }))).toThrow(
      /invalid cron expression "0 9 \* \*"/,
    );

    expect(svc.list()).toEqual([]);
  });

  it("leaves a disabled schedule with nextRunAt null", () => {
    const svc = service({ dir: tempDir(), now: clock("2024-03-01T08:00:00").now });
    const saved = svc.save(input({ enabled: false }));
    expect(saved.nextRunAt).toBeNull();

    // disabling an enabled schedule clears the planned run too
    expect(svc.save(input({ id: saved.id, enabled: false })).nextRunAt).toBeNull();
  });

  it("removes a schedule with its history and throws for an unknown id", () => {
    const dir = tempDir();
    const svc = service({ dir, now: clock("2024-03-01T08:00:00").now });
    const saved = svc.save(input());

    svc.remove(saved.id);
    expect(svc.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "schedules.json"), "utf8"))).toEqual({
      schedules: [],
    });

    expect(() => svc.remove(saved.id)).toThrow(/unknown schedule id/);
  });

  it("loads an empty list from a missing file", () => {
    expect(service({ dir: tempDir() }).list()).toEqual([]);
  });

  it("loads an empty list instead of throwing on a corrupt file", () => {
    const dir = tempDir();
    const path = join(dir, "schedules.json");
    writeFileSync(path, "{ not json");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = service({ dir });

    expect(svc.list()).toEqual([]);
    // and the store still works afterwards
    const saved = svc.save(input());
    expect(svc.list()).toEqual([saved]);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    warn.mockRestore();
  });

  it("pushes a stale nextRunAt forward on load instead of catching up", async () => {
    const dir = tempDir();
    const createRun = vi.fn(async () => ({ sessionId: "sess-1" }));
    const now = clock("2024-03-01T08:00:00").now;
    service({ dir, now }).save(input({ cron: "0 9 * * *" }));

    // the server was down past the planned run
    const later = clock("2024-03-05T12:00:00").now;
    const svc = service({ dir, now: later, createRun });

    const [schedule] = svc.list();
    expect(schedule?.nextRunAt).toBe(new Date(2024, 2, 6, 9, 0, 0).getTime());
    expect(createRun).not.toHaveBeenCalled();
  });
});

describe("ScheduleService.runNow", () => {
  it("records an ok run with the session id and advances nextRunAt", async () => {
    const dir = tempDir();
    const now = clock("2024-03-01T08:00:00");
    const svc = service({
      dir,
      now: now.now,
      createRun: async () => ({ sessionId: "sess-42", sessionFile: "/tmp/s.jsonl" }),
    });
    const saved = svc.save(input());

    const run = await svc.runNow(saved.id);

    expect(run).toEqual({
      at: new Date("2024-03-01T08:00:00").getTime(),
      status: "ok",
      sessionId: "sess-42",
      sessionFile: "/tmp/s.jsonl",
    });

    const [after] = svc.list();
    expect(after?.lastRunAt).toBe(run.at);
    expect(after?.history).toEqual([run]);
    expect(after?.nextRunAt).toBe(new Date(2024, 2, 1, 9, 0, 0).getTime());

    const onDisk = JSON.parse(readFileSync(join(dir, "schedules.json"), "utf8")) as {
      schedules: Schedule[];
    };
    expect(onDisk.schedules[0]?.history).toEqual([run]);
  });

  it("recomputes nextRunAt strictly forward so one minute cannot fire twice", async () => {
    const now = clock("2024-03-01T08:00:00");
    const svc = service({ dir: tempDir(), now: now.now });
    const saved = svc.save(input({ cron: "* * * * *" }));

    // fire exactly on the planned instant
    now.set("2024-03-01T08:01:00");
    const first = await svc.runNow(saved.id);
    const next = svc.list()[0]?.nextRunAt;

    expect(first.status).toBe("ok");
    expect(next).toBe(new Date(2024, 2, 1, 8, 2, 0).getTime());
    expect(next!).toBeGreaterThan(first.at);
  });

  it("records a failed run as an error entry instead of throwing", async () => {
    const seen: string[] = [];
    const svc = service({
      dir: tempDir(),
      now: clock("2024-03-01T08:00:00").now,
      createRun: async (schedule) => {
        seen.push(schedule.name);
        throw new Error("session blew up");
      },
    });
    const saved = svc.save(input());

    const run = await svc.runNow(saved.id);

    expect(run.status).toBe("error");
    expect(run.error).toBe("Error: session blew up");
    expect(run.sessionId).toBeUndefined();
    expect(seen).toEqual(["nightly"]);

    const [after] = svc.list();
    expect(after?.history).toEqual([run]);
    expect(after?.lastRunAt).toBe(run.at);
    expect(after?.nextRunAt).not.toBeNull();
  });

  it("throws for an unknown id without creating a session", async () => {
    const createRun = vi.fn(async () => ({ sessionId: "s" }));
    const svc = service({ dir: tempDir(), createRun });
    await expect(svc.runNow("nope")).rejects.toThrow(/unknown schedule id/);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("caps history at 100 entries, newest first", async () => {
    const svc = service({ dir: tempDir(), now: clock("2024-03-01T08:00:00").now });
    const saved = svc.save(input());

    for (let i = 0; i < 105; i++) await svc.runNow(saved.id);

    const history = svc.list()[0]?.history ?? [];
    expect(history).toHaveLength(100);
    expect(history.every((run: ScheduleRun) => run.status === "ok")).toBe(true);
  });
});

describe("ScheduleService timer loop", () => {
  it("starts and stops idempotently and leaves no pending timer", () => {
    vi.useFakeTimers();
    const svc = service({ dir: tempDir(), now: () => new Date(Date.now()) });
    svc.save(input({ cron: "* * * * *" }));

    svc.start();
    expect(vi.getTimerCount()).toBe(1);
    svc.start();
    expect(vi.getTimerCount()).toBe(1);

    svc.stop();
    expect(vi.getTimerCount()).toBe(0);
    svc.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => {
      svc.start();
      svc.stop();
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fires a due schedule once and re-arms for the next minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 1, 8, 0, 30));
    const createRun = vi.fn(async () => ({ sessionId: "sess-fired" }));
    const svc = service({ dir: tempDir(), now: () => new Date(Date.now()), createRun });
    svc.save(input({ cron: "* * * * *" }));

    svc.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(createRun).toHaveBeenCalledTimes(1);
    const [after] = svc.list();
    expect(after?.history).toHaveLength(1);
    expect(after?.history[0]?.sessionId).toBe("sess-fired");
    expect(after?.nextRunAt).toBe(new Date(2024, 2, 1, 8, 2, 0).getTime());

    svc.stop();
  });

  it("never fires a disabled schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 1, 8, 0, 30));
    const createRun = vi.fn(async () => ({ sessionId: "sess" }));
    const svc = service({ dir: tempDir(), now: () => new Date(Date.now()), createRun });
    svc.save(input({ cron: "* * * * *", enabled: false }));

    svc.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(createRun).not.toHaveBeenCalled();

    svc.stop();
  });
});
