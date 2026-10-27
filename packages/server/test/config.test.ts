// The config store is the only code allowed to turn a config id into a path, so
// these tests pin the things that would be dangerous to get wrong: the id
// allowlist, validation-before-write, optimistic concurrency, and the fact that
// saving never loses the previous version or leaves a stray temp file.
//
// Every case runs against a mkdtemp directory — the real ~/.pi/agent is never
// read or written here.
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import type { ConfigId } from "@uipi/protocol";
import {
  CONFIG_FILES,
  ConfigConflictError,
  listConfigs,
  readConfig,
  writeConfig,
} from "../src/config.js";

const dirs: string[] = [];

/** A throwaway agent dir, removed again in afterEach. */
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uipi-config-"));
  dirs.push(dir);
  return dir;
}

/** Put `text` at one of pi's config files inside a temp agent dir. */
function seed(dir: string, id: ConfigId, text: string): string {
  const path = join(dir, CONFIG_FILES[id]);
  writeFileSync(path, text);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config store", () => {
  it("round-trips a document through read and write", async () => {
    const dir = agentDir();
    const path = seed(dir, "settings", '{"theme":"dark"}\n');

    const read = await readConfig(dir, "settings");
    expect(read.docId).toBe("settings");
    expect(read.text).toBe('{"theme":"dark"}\n');
    expect(read.mtimeMs).toBeGreaterThan(0);

    const written = await writeConfig(dir, "settings", read.mtimeMs, '{"theme":"light"}\n');
    expect(written.docId).toBe("settings");
    expect(written.text).toBe('{"theme":"light"}\n');
    expect(readFileSync(path, "utf8")).toBe('{"theme":"light"}\n');
    expect((await readConfig(dir, "settings")).text).toBe('{"theme":"light"}\n');
  });

  it("lists only the files that exist, with their mtimes", async () => {
    const dir = agentDir();
    seed(dir, "settings", "{}");
    seed(dir, "mcp", "{}");

    const docs = await listConfigs(dir);

    expect(docs.map((d) => d.id).sort()).toEqual(["mcp", "settings"]);
    for (const doc of docs) expect(doc.mtimeMs).toBeGreaterThan(0);
  });

  it("rejects an unknown id without touching the filesystem", async () => {
    const dir = agentDir();
    const bad = "../auth" as ConfigId;

    await expect(readConfig(dir, bad)).rejects.toThrow(/unknown config id/);
    await expect(listConfigs(dir)).resolves.toEqual([]);
    await expect(writeConfig(dir, bad, 0, "{}")).rejects.toThrow(/unknown config id/);
    expect(existsSync(join(dir, "..", "auth.json"))).toBe(false);
  });

  it("rejects invalid JSON and leaves the file untouched", async () => {
    const dir = agentDir();
    const path = seed(dir, "sandbox", '{"allow":[]}');
    const before = await readConfig(dir, "sandbox");

    await expect(writeConfig(dir, "sandbox", before.mtimeMs, "{ not json")).rejects.toThrow(
      /not valid JSON/,
    );

    expect(readFileSync(path, "utf8")).toBe('{"allow":[]}');
    expect(existsSync(`${path}.bak`)).toBe(false);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("detects an mtime conflict and reports the current on-disk text", async () => {
    const dir = agentDir();
    const path = seed(dir, "settings", '{"a":1}');
    const stale = await readConfig(dir, "settings");

    // someone else edits the file after the client's read (mtime forced later,
    // so the test cannot pass by accident on a same-millisecond write)
    writeFileSync(path, '{"a":2}');
    utimesSync(path, new Date(stale.mtimeMs + 5000), new Date(stale.mtimeMs + 5000));
    const current = await readConfig(dir, "settings");
    expect(current.mtimeMs).not.toBe(stale.mtimeMs);

    const err = await writeConfig(dir, "settings", stale.mtimeMs, '{"a":3}').catch((e) => e);
    expect(err).toBeInstanceOf(ConfigConflictError);
    expect((err as ConfigConflictError).doc).toEqual(current);
    expect(readFileSync(path, "utf8")).toBe('{"a":2}');
  });

  it("keeps the previous content in <file>.bak, overwriting the older backup", async () => {
    const dir = agentDir();
    const path = seed(dir, "settings", '{"v":1}');

    const first = await readConfig(dir, "settings");
    const second = await writeConfig(dir, "settings", first.mtimeMs, '{"v":2}');
    expect(readFileSync(`${path}.bak`, "utf8")).toBe('{"v":1}');

    await writeConfig(dir, "settings", second.mtimeMs, '{"v":3}');
    expect(readFileSync(`${path}.bak`, "utf8")).toBe('{"v":2}');
    expect(readFileSync(path, "utf8")).toBe('{"v":3}');
  });

  it("writes atomically and leaves no .tmp behind", async () => {
    const dir = agentDir();
    const path = seed(dir, "settings", "{}");
    const doc = await readConfig(dir, "settings");

    await writeConfig(dir, "settings", doc.mtimeMs, '{"ok":true}');

    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"ok":true}');
  });

  it("preserves unknown top-level keys in roles.json", async () => {
    const dir = agentDir();
    seed(dir, "roles", '{"roles":{"local":{"model":"m"}},"futureKey":{"x":1}}');

    const read = await readConfig(dir, "roles");
    // an edit by a newer/older pi must not cost the UI the keys it doesn't model
    const edited = JSON.parse(read.text) as Record<string, unknown>;
    edited.active = "local";
    const written = await writeConfig(dir, "roles", read.mtimeMs, JSON.stringify(edited, null, 2));

    expect(written.text).toBe(JSON.stringify(edited, null, 2));
    const back = JSON.parse((await readConfig(dir, "roles")).text) as Record<string, unknown>;
    expect(back.futureKey).toEqual({ x: 1 });
    expect(back.roles).toEqual({ local: { model: "m" } });
    expect(back.active).toBe("local");
  });
});
