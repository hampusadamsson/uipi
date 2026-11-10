// Server-owned store + timer loop for scheduled sessions.
//
// The UI never touches `<agentDir>/schedules.json` itself: it sends whole
// `ScheduleInput`s and this module owns ids, `nextRunAt`, `lastRunAt` and
// `history`. Because nobody else writes the file there is no mtime
// optimistic-concurrency check (unlike config.ts) — the only write race is
// between two of our own saves, which a per-call unique temp file handles.
//
// Session creation is NOT implemented here: the caller injects `createRun`, so
// this file stays testable without the agent SDK and transport.ts can decide how
// a session is born.
//
// The API is synchronous for everything except `runNow`, so the store is loaded
// with `readFileSync` on first access and persisted with a sync tmp+rename —
// the same atomic shape as `atomicWriteWithBackup`, minus the async plumbing.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Schedule, ScheduleId, ScheduleInput, ScheduleRun } from "@uipi/protocol";
import { nextRunAt, parseCron } from "./cron.js";

/** Newest-first history cap per schedule. */
const HISTORY_LIMIT = 100;

/** Upper bound on one timer hop, so a clock jump or a missed timer self-corrects. */
const MAX_DELAY_MS = 60_000;

/** What `createRun` reports back on success; the fields are optional because a
 * session may be created without a durable file or without a live id. */
export interface ScheduleRunResult {
  sessionId?: string;
  sessionFile?: string;
}

/** Creates the session a schedule run belongs to. May throw — that is a run error. */
export type CreateRun = (schedule: Schedule) => Promise<ScheduleRunResult>;

export interface ScheduleServiceOptions {
  /** Directory the schedules file lives in (normally pi's agent dir). */
  agentDir: string;
  /** Override the file path; tests point it at a temp dir. */
  file?: string;
  /** Clock, injectable for tests. */
  now?: () => Date;
  createRun: CreateRun;
}

/** On-disk shape. An object (not a bare array) so the format can grow. */
interface StoredFile {
  schedules: Schedule[];
}

/** Distinguishes tmp files written by concurrent saves within this process. */
let tmpCounter = 0;

/**
 * Replace `path` with `text` via a sibling tmp file + rename.
 *
 * The tmp name is unique per call so two saves in flight at once cannot share
 * (and clobber) one file; the `finally` drops any temp left by a failed write or
 * rename instead of leaving it to block a later directory removal.
 */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Deep-enough copy: callers must not be able to mutate our state through a result. */
function cloneSchedule(schedule: Schedule): Schedule {
  return { ...schedule, history: schedule.history.map((run) => ({ ...run })) };
}

export class ScheduleService {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly createRun: CreateRun;

  /** Lazily loaded map; `null` until first access. */
  private store: Map<ScheduleId, Schedule> | null = null;

  /** The single pending wake-up, if any. */
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(opts: ScheduleServiceOptions) {
    this.file = opts.file ?? join(opts.agentDir, "schedules.json");
    this.now = opts.now ?? (() => new Date());
    this.createRun = opts.createRun;
  }

  // ---------- queries ----------

  /** Every schedule, sorted by name. */
  list(): Schedule[] {
    const all = [...this.schedules().values()].map(cloneSchedule);
    return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Epoch ms of the next run for `cron` strictly after `from`, or null when invalid. */
  nextRunAtFor(cron: string, from: Date): number | null {
    try {
      return nextRunAt(parseCron(cron), from).getTime();
    } catch {
      return null;
    }
  }

  // ---------- mutations ----------

  /** Create (no `id`) or update (known `id`) a schedule and persist it. */
  save(input: ScheduleInput): Schedule {
    this.validate(input);
    const store = this.schedules();

    let schedule: Schedule;
    if (input.id === undefined) {
      schedule = {
        id: randomUUID(),
        name: input.name,
        cron: input.cron,
        prompt: input.prompt,
        role: input.role,
        cwd: input.cwd,
        enabled: input.enabled,
        nextRunAt: null,
        lastRunAt: null,
        history: [],
      };
    } else {
      const existing = store.get(input.id);
      if (!existing) throw new Error(`unknown schedule id "${input.id}"`);
      schedule = { ...existing };
    }

    schedule.name = input.name;
    schedule.cron = input.cron;
    schedule.prompt = input.prompt;
    schedule.role = input.role;
    schedule.cwd = input.cwd;
    if (input.agentDir !== undefined) schedule.agentDir = input.agentDir;
    else delete schedule.agentDir;
    schedule.enabled = input.enabled;
    schedule.nextRunAt = schedule.enabled ? this.nextRunAtFor(schedule.cron, this.now()) : null;

    store.set(schedule.id, schedule);
    this.persist();
    // A save can change what the earliest due time is, so re-arm if we are live.
    if (this.started) this.rearm();
    return cloneSchedule(schedule);
  }

  /** Delete a schedule; its history goes with it. Throws for an unknown id. */
  remove(id: ScheduleId): void {
    const store = this.schedules();
    if (!store.delete(id)) throw new Error(`unknown schedule id "${id}"`);
    this.persist();
    if (this.started) this.rearm();
  }

  /**
   * Run a schedule once, right now, and record the result in its history.
   *
   * Never throws for a failed run: the error is the history entry. It DOES throw
   * for an unknown id, before any session is created.
   */
  async runNow(id: ScheduleId): Promise<ScheduleRun> {
    const store = this.schedules();
    const schedule = store.get(id);
    if (!schedule) throw new Error(`unknown schedule id "${id}"`);

    const at = this.now().getTime();
    let run: ScheduleRun;
    try {
      const result = await this.createRun(cloneSchedule(schedule));
      run = { at, status: "ok", sessionId: result.sessionId, sessionFile: result.sessionFile };
    } catch (e) {
      run = { at, status: "error", error: String(e) };
    }

    schedule.lastRunAt = at;
    // Recomputed from the current clock (which `nextRunAt` makes strictly later),
    // so a due schedule cannot fire twice for the same minute.
    schedule.nextRunAt = schedule.enabled ? this.nextRunAtFor(schedule.cron, this.now()) : null;
    schedule.history.unshift(run);
    if (schedule.history.length > HISTORY_LIMIT) schedule.history.length = HISTORY_LIMIT;

    this.persist();
    if (this.started) this.rearm();
    return { ...run };
  }

  // ---------- timer loop ----------

  /** Start the timer loop. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedules(); // load (and forward-skip stale `nextRunAt`s) before arming
    this.rearm();
  }

  /** Stop the timer loop. Idempotent. */
  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Arm a single wake-up for the earliest enabled `nextRunAt`, capped at MAX_DELAY_MS. */
  private rearm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started) return;

    let earliest: number | null = null;
    for (const schedule of this.schedules().values()) {
      if (!schedule.enabled || schedule.nextRunAt === null) continue;
      if (earliest === null || schedule.nextRunAt < earliest) earliest = schedule.nextRunAt;
    }
    if (earliest === null) return; // nothing enabled: a save/start will arm us again

    const delay = Math.min(Math.max(earliest - this.now().getTime(), 0), MAX_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    // A pending wake-up must not keep the process alive.
    this.timer.unref?.();
  }

  /** Fire everything that is due, then re-evaluate (which also re-arms). */
  private async tick(): Promise<void> {
    if (!this.started) return;
    const nowMs = this.now().getTime();
    const due = [...this.schedules().values()].filter(
      (s) => s.enabled && s.nextRunAt !== null && s.nextRunAt <= nowMs,
    );

    for (const schedule of due) {
      if (!this.started) return;
      try {
        await this.runNow(schedule.id);
      } catch (e) {
        // Only reachable if the schedule vanished mid-tick; do not kill the loop.
        console.warn(`schedules: run of ${schedule.id} failed: ${String(e)}`);
      }
    }

    if (this.started) this.rearm();
  }

  // ---------- persistence ----------

  /** The map, loaded from disk on first access. */
  private schedules(): Map<ScheduleId, Schedule> {
    if (this.store) return this.store;
    const store = new Map<ScheduleId, Schedule>();
    const nowMs = this.now().getTime();

    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      this.store = store; // no file yet: a fresh install has no schedules
      return store;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StoredFile>;
      const list = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
      for (const schedule of list) {
        if (!schedule || typeof schedule.id !== "string") continue;
        // Missed runs are NOT caught up: anything stale is pushed forward, and a
        // disabled schedule never carries a planned time.
        const stale = schedule.nextRunAt === null || schedule.nextRunAt <= nowMs;
        store.set(schedule.id, {
          ...schedule,
          history: Array.isArray(schedule.history) ? schedule.history : [],
          nextRunAt:
            schedule.enabled && stale
              ? this.nextRunAtFor(schedule.cron, new Date(nowMs))
              : schedule.enabled
                ? schedule.nextRunAt
                : null,
        });
      }
    } catch (e) {
      // A corrupt file must not take the server down: start empty and say so.
      console.warn(`schedules: ignoring unreadable ${this.file}: ${String(e)}`);
      store.clear();
    }

    this.store = store;
    return store;
  }

  /** Write the whole store back, atomically. */
  private persist(): void {
    const file: StoredFile = { schedules: [...this.schedules().values()] };
    atomicWrite(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }

  // ---------- validation ----------

  private validate(input: ScheduleInput): void {
    if (typeof input.name !== "string" || input.name.trim() === "") {
      throw new Error("schedule name must not be empty");
    }
    if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
      throw new Error("schedule prompt must not be empty");
    }
    if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
      throw new Error("schedule cwd must not be empty");
    }
    try {
      parseCron(input.cron);
    } catch (e) {
      throw new Error(`invalid cron expression "${input.cron}": ${(e as Error).message}`, {
        cause: e,
      });
    }
  }
}
