// The sidebar badges every session row with its role. The role is not in pi's
// session index (`SessionManager.list`), so it is replayed from each session
// JSONL — the same rule as `mirrorActiveRole`, minus the config default: last
// `role-switch` entry wins, and `{ role: null }` is a real answer.
//
// Pinned here:
//  1. Streaming replay: last entry wins, malformed lines are skipped, a missing
//     or unreadable file means "roleless" (never a throw during a listing).
//  2. Cache by (path, mtimeMs, size): a repeat listing opens no file, and either
//     key changing makes the new role visible.
//  3. SessionSummary carries `role` for on-disk sessions and for brand-new live
//     sessions that have no file yet (those use the live mirror).
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionService,
  cachedSessionRole,
  pruneSessionRoleCache,
  roleFromSessionFile,
} from "../src/sessions.js";
import type { SessionSummary } from "@uipi/protocol";

// Counting file opens is the observable proof of a cache hit: the parser streams
// through `createReadStream`, so "no extra open for this path" means "no re-read".
const openedPaths = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      openedPaths.push(String(args[0]));
      return actual.createReadStream(...args);
    },
  };
});

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function roleEntry(role: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "custom", customType: "role-switch", data: { role }, ...extra });
}

function messageEntry(text: string): string {
  return JSON.stringify({
    type: "message",
    id: `m${text}`,
    parentId: null,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** Write a real session JSONL: a header line plus the given lines. */
function writeSession(file: string, lines: string[], touchMs?: number): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  if (touchMs !== undefined) {
    const at = touchMs / 1000;
    utimesSync(file, at, at);
  }
}

function opensFor(path: string): number {
  return openedPaths.filter((p) => p === path).length;
}

beforeEach(() => {
  openedPaths.length = 0;
  pruneSessionRoleCache([]);
});

describe("roleFromSessionFile", () => {
  it("returns the LAST role-switch role when several exist", async () => {
    const file = join(tmp("uipi-role-"), "s.jsonl");
    writeSession(file, [
      roleEntry("researcher"),
      roleEntry("work"),
      messageEntry("hi"),
      roleEntry("architect"),
    ]);
    expect(await roleFromSessionFile(file)).toBe("architect");
  });

  it("returns null when the file has no role-switch entry", async () => {
    const file = join(tmp("uipi-role-"), "s.jsonl");
    writeSession(file, [
      messageEntry("hi"),
      JSON.stringify({ type: "custom", customType: "todo", data: { role: "ignored" } }),
    ]);
    expect(await roleFromSessionFile(file)).toBeNull();
  });

  it("treats a role:null entry as roleless (no config fallback)", async () => {
    const file = join(tmp("uipi-role-"), "s.jsonl");
    writeSession(file, [roleEntry("work"), roleEntry(null)]);
    expect(await roleFromSessionFile(file)).toBeNull();
  });

  it("skips malformed lines and still finds the surrounding valid entry", async () => {
    const file = join(tmp("uipi-role-"), "s.jsonl");
    writeSession(file, [
      roleEntry("coder"),
      "{ this is not json",
      '{"type":"custom","customType":"role-switch","data":{"role":"work"',
      roleEntry("architect"),
      "}{",
    ]);
    expect(await roleFromSessionFile(file)).toBe("architect");
  });

  it("returns null for a missing file instead of throwing", async () => {
    expect(await roleFromSessionFile(join(tmp("uipi-role-"), "nope.jsonl"))).toBeNull();
  });
});

describe("role cache keyed by (path, mtimeMs, size)", () => {
  it("does not re-read the file on a second lookup", async () => {
    const file = join(tmp("uipi-role-"), "s.jsonl");
    writeSession(file, [roleEntry("work")]);

    expect(await cachedSessionRole(file)).toEqual({ exists: true, role: "work" });
    const afterFirst = opensFor(file);
    expect(afterFirst).toBeGreaterThan(0);

    expect(await cachedSessionRole(file)).toEqual({ exists: true, role: "work" });
    expect(opensFor(file)).toBe(afterFirst); // cache hit: zero new opens
  });

  it("invalidate on a new mtime even when the size is unchanged", async () => {
    const file = join(tmp("uipi-role-"), "s.jsonl");
    const base = Date.now() - 10_000;
    writeSession(file, [roleEntry("work")], base);
    const before = statSync(file);
    expect(await cachedSessionRole(file)).toEqual({ exists: true, role: "work" });

    // Same byte length, different role, newer mtime → new answer despite same size.
    writeSession(file, [roleEntry("mark")], base + 5_000);
    const after = statSync(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);

    expect(await cachedSessionRole(file)).toEqual({ exists: true, role: "mark" });
  });

  it("invalidate when an entry is appended", async () => {
    const file = join(tmp("uipi-role-"), "s.jsonl");
    writeSession(file, [roleEntry("work")]);
    expect(await cachedSessionRole(file)).toEqual({ exists: true, role: "work" });

    writeSession(file, [roleEntry("work"), roleEntry("architect")]);
    expect(await cachedSessionRole(file)).toEqual({ exists: true, role: "architect" });
  });

  it("reports a path with no file as absent so the live mirror can answer", async () => {
    const file = join(tmp("uipi-role-"), "not-written-yet.jsonl");
    expect(await cachedSessionRole(file)).toEqual({ exists: false, role: null });
  });
});

// ---------- listing: SessionSummary.role ----------

type Entry = { type: "custom"; customType: string; data?: unknown };

function fakeSession(entries: Entry[] = []) {
  return {
    isIdle: true,
    thinkingLevel: "medium",
    messages: [],
    model: undefined,
    sessionManager: { getBranch: () => entries },
    getActiveToolNames: () => ["read"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: () => Promise.resolve(),
  };
}

function fakeLive(overrides: { id: string; cwd: string; sessionFile?: string; role?: string }) {
  const entries: Entry[] = overrides.role
    ? [{ type: "custom", customType: "role-switch", data: { role: overrides.role } }]
    : [];
  return {
    id: overrides.id,
    cwd: overrides.cwd,
    agentDir: join(overrides.cwd, "agent"),
    sessionFile: overrides.sessionFile,
    session: fakeSession(entries),
    uiHost: {},
    subscribers: new Map(),
    createdAt: Date.now(),
  };
}

/** Plant a session file where `SessionManager.list(cwd)` will find it. */
function sessionFileFor(agentDir: string, cwd: string, id: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
}

function header(id: string, cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  });
}

async function list(svc: SessionService): Promise<SessionSummary[]> {
  return (svc as unknown as { listAllSessions(): Promise<SessionSummary[]> }).listAllSessions();
}

describe("SessionSummary.role", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeAll(() => {
    agentDir = tmp("uipi-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  it("carries the file's role for on-disk sessions and null for roleless ones", async () => {
    const svc = new SessionService(undefined as never);
    const cwd = process.cwd();
    const withRole = sessionFileFor(agentDir, cwd, "withrole");
    const roleless = sessionFileFor(agentDir, cwd, "roleless");
    writeSession(withRole, [header("withrole", cwd), messageEntry("hi"), roleEntry("coder")]);
    writeSession(roleless, [header("roleless", cwd), messageEntry("yo")]);

    const sessions = await list(svc);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("withrole")?.role).toBe("coder");
    expect(byId.get("roleless")?.role).toBeNull();
    expect(byId.get("withrole")?.live).toBe(false);
  });

  it("carries the live mirror's role for a brand-new session with no file on disk", async () => {
    const svc = new SessionService(undefined as never);
    const cwd = tmp("uipi-cwd-");
    // brand-new live sessions know their session file path before it exists
    const pending = sessionFileFor(agentDir, cwd, "fresh");
    const live = fakeLive({ id: "fresh", cwd, sessionFile: pending, role: "architect" });
    (svc as unknown as { live: Map<string, unknown> }).live.set("fresh", live);

    const sessions = await list(svc);
    const fresh = sessions.find((s) => s.sessionId === "fresh");
    expect(fresh?.live).toBe(true);
    expect(fresh?.role).toBe("architect");
    expect(fresh?.sessionFile).toBe(pending); // listed from the live map, not a file
  });

  it("does not re-read on a repeat listing", async () => {
    const svc = new SessionService(undefined as never);
    const cwd = process.cwd();
    const file = sessionFileFor(agentDir, cwd, "repeat");
    writeSession(file, [header("repeat", cwd), messageEntry("hi"), roleEntry("work")]);

    openedPaths.length = 0;
    expect((await list(svc)).find((s) => s.sessionId === "repeat")?.role).toBe("work");
    const firstListing = opensFor(file);

    openedPaths.length = 0;
    expect((await list(svc)).find((s) => s.sessionId === "repeat")?.role).toBe("work");
    const secondListing = opensFor(file);

    // The session index re-opens each file to build its info; the role replay must
    // not add a second open, so the second listing opens strictly fewer times.
    expect(firstListing).toBeGreaterThan(0);
    expect(secondListing).toBeLessThan(firstListing);
  });
});
