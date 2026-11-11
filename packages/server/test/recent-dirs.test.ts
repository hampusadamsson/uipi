// Recent project dirs are the sidebar's only memory of projects you have left.
//
// They used to live in a plain in-memory array written only by `newSession`, so
// after a server restart every project other than the server's own cwd was
// invisible: `listAllSessions()` seeds from `SessionManager.list(process.cwd())`
// plus the live sessions' cwds, and an archived project has neither.
//
// Pinned here:
//  1. `pushRecentDir` de-duplicates, is most-recent-first and caps at 20.
//  2. The list is persisted to `<agentDir>/recent-dirs.json` and survives a
//     "restart" (a second service on the same agent dir).
//  3. A corrupt `recent-dirs.json` loads as empty instead of throwing.
//  4. Opening an archived session counts as visiting its project.
//  5. `listAllSessions` includes a real session file that lives in a recent dir
//     which is neither the server's cwd nor covered by a live session.
//
// Fakes follow `session-list.test.ts`: pi itself is not started, and the fake
// runtime is shaped around the real `SessionManager` the server passes in, so
// cwd/sessionFile behave exactly like production.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { S2C, SessionSummary } from "@uipi/protocol";
import { SessionService, type CreateRuntimeFn } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Run `fn` against a fresh temp agent dir (pi's own default is never touched) and
 * clean up after. Every test gets its own dir so the persisted recents of one test
 * cannot leak into the next.
 */
async function withAgentDir(fn: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = tmp("uipi-recent-agent-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await fn(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

/** Where pi stores a session for `cwd` under `agentDir` (same encoding pi uses). */
function sessionDirFor(agentDir: string, cwd: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

/** Write a real session JSONL — header line (with the real cwd) plus one message. */
function writeSession(file: string, id: string, cwd: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    ].join("\n") + "\n",
  );
}

/** A runtime factory good enough for `materialize()` — see `session-list.test.ts`. */
function fakeRuntime() {
  const createRuntime = ((_factory: unknown, options: { sessionManager: unknown }) => {
    const manager = options.sessionManager as {
      getCwd: () => string;
      getSessionFile: () => string | undefined;
    };
    const session = {
      isIdle: true,
      thinkingLevel: "medium",
      messages: [] as unknown[],
      model: undefined,
      get sessionFile() {
        return manager.getSessionFile();
      },
      sessionManager: manager,
      getActiveToolNames: () => ["read"],
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      prompt: () => Promise.resolve(),
      bindExtensions: () => Promise.resolve(),
      subscribe: () => () => {},
      dispose: () => {},
    };
    return Promise.resolve({ session });
  }) as unknown as CreateRuntimeFn;
  return { createRuntime };
}

/** The private store the protocol route reads, pushed directly (no session needed). */
function pushRecentDir(svc: SessionService, ...dirs: string[]): void {
  const impl = svc as unknown as { pushRecentDir(dir: string): void };
  for (const dir of dirs) impl.pushRecentDir(dir);
}

/** The production `proto/recentDirs` round trip. */
async function recentDirs(svc: SessionService): Promise<string[]> {
  const sent: S2C[] = [];
  await svc.handle({ type: "proto/recentDirs" }, (m) => sent.push(m), { send: () => {} });
  const reply = sent.find((m) => m.type === "proto.recentDirs") as
    Extract<S2C, { type: "proto.recentDirs" }> | undefined;
  return (reply?.dirs ?? []).map((d) => d.path);
}

async function list(svc: SessionService): Promise<SessionSummary[]> {
  return (svc as unknown as { listAllSessions(): Promise<SessionSummary[]> }).listAllSessions();
}

function storedDirs(agentDir: string): string[] {
  const raw = JSON.parse(readFileSync(join(agentDir, "recent-dirs.json"), "utf8")) as {
    dirs: string[];
  };
  return raw.dirs;
}

describe("recent dirs: push, persist, survive a restart", () => {
  it("de-duplicates, keeps most-recent-first, and caps at 20", async () => {
    await withAgentDir(async (agentDir) => {
      const svc = new SessionService(fakeRuntime().createRuntime);
      const dirs = Array.from({ length: 25 }, (_, i) => `/projects/p${i}`);

      pushRecentDir(svc, ...dirs);
      // re-pushing an existing dir moves it to the front instead of duplicating it
      pushRecentDir(svc, "/projects/p5");

      const seen = await recentDirs(svc);
      expect(seen).toHaveLength(20); // the 20 cap
      expect(seen[0]).toBe("/projects/p5"); // most recent first
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      // the newest 20 survivors: p5 then p24…p6
      expect(seen).toEqual([
        "/projects/p5",
        ...Array.from({ length: 19 }, (_, i) => `/projects/p${24 - i}`),
      ]);
      // and the cap is what was written to disk, not just what is in memory
      expect(storedDirs(agentDir)).toEqual(seen);
    });
  });

  it("loads the persisted dirs in a second service (restart)", async () => {
    await withAgentDir(async () => {
      const first = new SessionService(fakeRuntime().createRuntime);
      pushRecentDir(first, "/projects/alpha", "/projects/beta");

      // a fresh process would build a new service on the same agent dir
      const second = new SessionService(fakeRuntime().createRuntime);
      expect(await recentDirs(second)).toEqual(["/projects/beta", "/projects/alpha"]);
    });
  });

  it("tolerates a corrupt recent-dirs.json by starting empty", async () => {
    await withAgentDir(async (agentDir) => {
      writeFileSync(join(agentDir, "recent-dirs.json"), "{ not json at all");

      const svc = new SessionService(fakeRuntime().createRuntime);
      expect(await recentDirs(svc)).toEqual([]); // no throw, no dirs
      // the list is still built (the server's own cwd only) without throwing
      await expect(list(svc)).resolves.toBeInstanceOf(Array);

      // and a later push overwrites the corrupt file with a valid one
      pushRecentDir(svc, "/projects/recovered");
      expect(await recentDirs(svc)).toEqual(["/projects/recovered"]);
      expect(storedDirs(agentDir)).toEqual(["/projects/recovered"]);
    });
  });

  it("records the project dir of an opened archived session", async () => {
    await withAgentDir(async (agentDir) => {
      const projectCwd = tmp("uipi-recent-opened-");
      try {
        const file = join(sessionDirFor(agentDir, projectCwd), "2026-01-01T00-00-00-000Z_a.jsonl");
        writeSession(file, "archived-a", projectCwd, "an archived conversation");

        const svc = new SessionService(fakeRuntime().createRuntime);
        const sent: S2C[] = [];
        const sub: Subscriber = { send: (m) => sent.push(m) };
        await svc.handle(
          { type: "proto.openSession", sessionFilePath: file },
          (m) => sent.push(m),
          sub,
        );

        expect(await recentDirs(svc)).toContain(projectCwd);
        // persisted, so a restart still remembers the project
        const restarted = new SessionService(fakeRuntime().createRuntime);
        expect(await recentDirs(restarted)).toContain(projectCwd);
      } finally {
        rmSync(projectCwd, { recursive: true, force: true });
      }
    });
  });

  it("lists a session file in a recent dir that is neither the cwd nor live", async () => {
    await withAgentDir(async (agentDir) => {
      // a real pi session on disk in a *different* project than the server's cwd
      const projectCwd = tmp("uipi-recent-archived-");
      try {
        expect(projectCwd).not.toBe(process.cwd());
        const file = join(sessionDirFor(agentDir, projectCwd), "2026-01-01T00-00-00-000Z_b.jsonl");
        writeSession(file, "archived-b", projectCwd, "session from another project");

        // seed the recents the way a previous run would have, then "restart":
        // the new service has no live session for that project at all
        pushRecentDir(new SessionService(fakeRuntime().createRuntime), projectCwd);
        const fresh = new SessionService(fakeRuntime().createRuntime);

        const rows = (await list(fresh)).filter((s) => s.sessionFile === file);
        expect(rows).toHaveLength(1);
        expect(rows[0].cwd).toBe(projectCwd);
        expect(rows[0].firstMessage).toBe("session from another project");
      } finally {
        rmSync(projectCwd, { recursive: true, force: true });
      }
    });
  });
});
