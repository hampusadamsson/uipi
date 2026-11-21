// Sessionless role names: a page with no live session still gets the real list.
//
// The header's role picker asks a *live session* (`proto.roleNames` with an id),
// because the roles extension owns the list and only a session can reach it. The
// schedules form has no session — it edits a file — so it asks without an id and
// the server answers from `roles.json`, the same file the extension reads. One
// shape either way: names only, extension reserved words filtered out.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService, roleNamesFromConfig } from "../src/sessions.js";
import type { S2C } from "@uipi/protocol";

/** An agent dir holding a roles.json of the given shape (or raw text). */
function agentDirWith(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "uipi-roles-"));
  writeFileSync(
    join(dir, "roles.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
  return dir;
}

describe("roleNamesFromConfig", () => {
  it("lists the role names in roles.json order", async () => {
    const dir = agentDirWith({
      active: "work",
      roles: { work: { description: "dev" }, architect: {}, review: {} },
    });
    expect(await roleNamesFromConfig(dir)).toEqual(["work", "architect", "review"]);
  });

  it("filters the extension's reserved words", async () => {
    const dir = agentDirWith({ roles: { none: {}, reload: {}, keys: {}, off: {}, work: {} } });
    expect(await roleNamesFromConfig(dir)).toEqual(["work"]);
  });

  it("is empty when roles.json is missing", async () => {
    expect(await roleNamesFromConfig(mkdtempSync(join(tmpdir(), "uipi-empty-")))).toEqual([]);
  });

  it("is empty when roles.json is not valid JSON", async () => {
    expect(await roleNamesFromConfig(agentDirWith("{ not json"))).toEqual([]);
  });

  it("is empty when roles.json has no roles object", async () => {
    expect(await roleNamesFromConfig(agentDirWith({ active: "work" }))).toEqual([]);
    expect(await roleNamesFromConfig(agentDirWith({ roles: ["work"] }))).toEqual([]);
  });
});

describe("proto.roleNames without a session", () => {
  /** a service whose agent dir is `agentDir`, with no live sessions */
  function service(agentDir: string): SessionService {
    const svc = new SessionService(undefined as never);
    (svc as unknown as { defaultAgentDir: () => string }).defaultAgentDir = () => agentDir;
    return svc;
  }

  async function ask(agentDir: string, msg: Record<string, unknown>): Promise<S2C[]> {
    const sent: S2C[] = [];
    await service(agentDir).handle(msg as never, (m) => sent.push(m), {
      send: (m) => sent.push(m),
    } as never);
    return sent;
  }

  it("answers from roles.json with a null session id", async () => {
    const dir = agentDirWith({ roles: { work: {}, review: {} } });
    const sent = await ask(dir, { type: "proto.roleNames" });

    const reply = sent.find((m) => m.type === "proto.roleNames") as
      { sessionId: string | null; names: string[] } | undefined;
    expect(reply).toBeDefined();
    expect(reply!.sessionId).toBeNull();
    expect(reply!.names).toEqual(["work", "review"]);
    expect(sent.some((m) => m.type === "proto.error")).toBe(false);
  });

  it("answers an empty list rather than an error when roles.json is unreadable", async () => {
    const sent = await ask(mkdtempSync(join(tmpdir(), "uipi-empty-")), { type: "proto.roleNames" });

    const reply = sent.find((m) => m.type === "proto.roleNames") as { names: string[] } | undefined;
    expect(reply?.names).toEqual([]);
    expect(sent.some((m) => m.type === "proto.error")).toBe(false);
  });

  it("still errors for a session id that is not live", async () => {
    const sent = await ask(agentDirWith({ roles: { work: {} } }), {
      type: "proto.roleNames",
      sessionId: "nope",
    });
    expect(sent.some((m) => m.type === "proto.error")).toBe(true);
    expect(sent.some((m) => m.type === "proto.roleNames")).toBe(false);
  });
});
