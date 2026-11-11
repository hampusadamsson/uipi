// Opening an archived session used to replace its sidebar row with a ghost.
//
// `openSessionFile` guessed the project dir from pi's session-dir *name*, which
// loses the leading `/`, so `LiveSession.cwd` became a relative string such as
// `Users-hampus-program-uipi`. `SessionManager.list(that)` looks in an unrelated
// (empty) directory, the opened file never entered `infos`, and the
// `infos.has(file)` guard let a synthetic `"new session"` row through — same
// `sessionFile`, so the sidebar (keyed on it) lost the real row.
//
// Pinned here:
//  1. An opened on-disk session appears exactly ONCE, with the file's real name
//     and first message — never `"new session"`.
//  2. Its cwd is absolute and equals the session file's real project path.
//  3. A genuinely new session (no file on disk yet) still shows `"new session"`.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionService, type CreateRuntimeFn } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";
import type { S2C, SessionSummary } from "@uipi/protocol";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Where pi stores a session for `cwd` (same encoding pi itself uses). */
function sessionDirFor(agentDir: string, cwd: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

function messageEntry(id: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
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
      messageEntry("m1", text),
    ].join("\n") + "\n",
  );
}

/**
 * A runtime factory good enough for `materialize()`, following the same pattern as
 * the other server tests: pi itself is not started, but the session it returns is
 * shaped around the real `SessionManager` the server passed in the options, so the
 * cwd/sessionFile accessors behave exactly like production.
 */
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

async function list(svc: SessionService): Promise<SessionSummary[]> {
  return (svc as unknown as { listAllSessions(): Promise<SessionSummary[]> }).listAllSessions();
}

/** The production `proto.openSession` path, returning every frame it emitted. */
async function openSession(svc: SessionService, file: string): Promise<S2C[]> {
  const sent: S2C[] = [];
  const sub: Subscriber = { send: (m) => sent.push(m) };
  await svc.handle({ type: "proto.openSession", sessionFilePath: file }, (m) => sent.push(m), sub);
  return sent;
}

describe("session list for opened vs. brand-new sessions", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeAll(() => {
    agentDir = tmp("uipi-list-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  it("lists an opened on-disk session once, with its real row and absolute cwd", async () => {
    const projectCwd = tmp("uipi-list-project-");
    const file = join(
      sessionDirFor(agentDir, projectCwd),
      "2026-01-01T00-00-00-000Z_archived.jsonl",
    );
    writeSession(file, "archived", projectCwd, "archived conversation opener");

    const svc = new SessionService(fakeRuntime().createRuntime);
    const frames = await openSession(svc, file);

    const rows = (await list(svc)).filter((s) => s.sessionFile === file);
    expect(rows).toHaveLength(1); // exactly once — no ghost replacement
    expect(rows[0].displayName).not.toBe("new session");
    expect(rows[0].displayName).toBe("archived conversation opener");
    expect(rows[0].firstMessage).toBe("archived conversation opener");
    expect(rows[0].cwd).toBe(projectCwd);
    expect(rows[0].cwd.startsWith("/")).toBe(true);

    // and the open itself attached to the session's real cwd, not a dir-name guess
    const attached = frames.find((m) => m.type === "proto.attached") as
      { cwd: string; sessionId: string } | undefined;
    expect(attached).toBeDefined();
    expect(attached!.cwd).toBe(projectCwd);
  });

  it("still synthesises a 'new session' row for a session with no file on disk", async () => {
    const projectCwd = tmp("uipi-list-fresh-");
    const svc = new SessionService(fakeRuntime().createRuntime);
    const sent: S2C[] = [];
    const sub: Subscriber = { send: (m) => sent.push(m) };
    await svc.handle(
      { type: "proto.newSession", cwd: projectCwd, agentDir },
      (m) => sent.push(m),
      sub,
    );

    const attached = sent.find((m) => m.type === "proto.attached") as
      { sessionId: string; sessionFile: string | null } | undefined;
    expect(attached?.sessionFile).toBeTruthy();
    // pi creates the file only once the session has a message
    expect(existsSync(attached!.sessionFile!)).toBe(false);

    const rows = (await list(svc)).filter((s) => s.sessionFile === attached!.sessionFile);
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("new session");
    expect(rows[0].firstMessage).toBe("");
    expect(rows[0].live).toBe(true);
    expect(rows[0].cwd).toBe(projectCwd);
  });
});
