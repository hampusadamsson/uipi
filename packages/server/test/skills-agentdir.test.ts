// Regression: `proto.skills` used to resolve the agent dir from the request's
// `agentDir` field alone, while `proto.skillGet`/`proto.skillWrite` (and
// `proto.config*`) used the first live session's dir. The list and the editor
// could therefore address different directories — the list showing `<x>/skills`
// while an edit landed in `<y>/skills`.
//
// Both must now agree on the live session's dir. Runs over a real WebSocket
// against a service seeded with one live session, with a *different* agentDir in
// the request: the live session must win. Directories are mkdtemp, so the real
// ~/.pi/agent is never read or written.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { C2S, S2C } from "@uipi/protocol";
import { createServer } from "../src/transport.js";
import { SessionService } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";

let httpServer: import("node:http").Server;
/** the live session's agent dir: the one both routes must use */
let liveAgentDir: string;
/** an unrelated agent dir, passed as the request's `agentDir` */
let otherAgentDir: string;
let cwd: string;
let port = 0;

/** A SKILL.md under `<root>/skills/<name>/`. */
function seedSkill(root: string, name: string, description: string): void {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

beforeAll(async () => {
  liveAgentDir = mkdtempSync(join(tmpdir(), "uipi-skilldir-live-"));
  otherAgentDir = mkdtempSync(join(tmpdir(), "uipi-skilldir-other-"));
  cwd = mkdtempSync(join(tmpdir(), "uipi-skilldir-cwd-"));
  // the same skill name exists in *both* dirs with different descriptions, so
  // which dir a route resolved is visible in its answer
  seedSkill(liveAgentDir, "demo", "from the live session dir");
  seedSkill(otherAgentDir, "demo", "from the request field");

  const svc = new SessionService(undefined as never);
  (svc as unknown as { live: Map<string, unknown> }).live.set("s1", {
    id: "s1",
    cwd,
    agentDir: liveAgentDir,
    subscribers: new Map<Subscriber, true>(),
  });

  httpServer = createServer({ port: 0 }, svc).httpServer;
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  httpServer.close();
  for (const dir of [liveAgentDir, otherAgentDir, cwd]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<S2C> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(String(raw)) as S2C);
    });
  });
}

/** One request/response round trip on a fresh connection. */
async function request(msg: C2S): Promise<S2C> {
  const ws = await connect();
  ws.send(JSON.stringify(msg));
  const reply = await nextMessage(ws);
  ws.close();
  return reply;
}

describe("agent dir resolution for the skills list and editor", () => {
  it("lists skills from the live session's agent dir, not the request field", async () => {
    const reply = await request({ type: "proto.skills", cwd, agentDir: otherAgentDir });

    expect(reply.type).toBe("proto.skills");
    const skills = (reply as Extract<S2C, { type: "proto.skills" }>).skills;
    expect(skills).toEqual([
      { name: "demo", description: "from the live session dir", scope: "user" },
    ]);
  });

  it("resolves the same directory for the list and the skill editor", async () => {
    const listReply = await request({ type: "proto.skills", cwd, agentDir: otherAgentDir });
    const getReply = await request({ type: "proto.skillGet", name: "demo" });

    expect(getReply.type).toBe("proto.skillGet");
    const listed = (listReply as Extract<S2C, { type: "proto.skills" }>).skills[0];
    const read = getReply as Extract<S2C, { type: "proto.skillGet" }>;

    // the two dirs hold the same skill name with different descriptions, so the
    // descriptions agreeing is what proves both routes hit one directory
    expect(read.name).toBe(listed.name);
    expect(read.frontmatter).toContain(`description: ${listed.description}`);
  });

  it("writes an edit into the directory the list read from", async () => {
    const reply = await request({
      type: "proto.skillWrite",
      op: "update",
      name: "demo",
      frontmatter: "description: edited",
    });

    expect(reply.type).toBe("proto.skillWrite");
    // the live session's file changed…
    expect(readFileSync(join(liveAgentDir, "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "---\nname: demo\ndescription: edited\n---\n\nBody.\n",
    );
    // …and the request field's copy did not
    expect(readFileSync(join(otherAgentDir, "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "---\nname: demo\ndescription: from the request field\n---\n\nBody.\n",
    );
  });

  it("falls back to the requested dir for the list once no session is live", async () => {
    // no live session at all: `agentDir` is what the list falls back to
    const svc = new SessionService(undefined as never);
    const reply = await new Promise<S2C>((resolve) => {
      void svc.handle({ type: "proto.skills", cwd, agentDir: otherAgentDir }, resolve, {
        send: () => {},
      });
    });

    const skills = (reply as Extract<S2C, { type: "proto.skills" }>).skills;
    expect(skills).toEqual([
      { name: "demo", description: "from the request field", scope: "user" },
    ]);
  });
});
