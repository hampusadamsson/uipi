// Server-side store for pi's editable config documents.
//
// The client never names a path, only a `ConfigId`. `CONFIG_FILES` is the single
// id → filename mapping and `configPath` is the single place that turns an id
// into a path, so the set of reachable files is fixed at compile time: no
// request can name `auth.json`, `mcp-auth.json` or anything under `sessions/`.
//
// Documents are opaque text: the server parses the JSON only to reject broken
// input, never re-serializes it, so unknown keys a newer/older pi writes survive
// a round trip through the web UI untouched.
import { copyFile, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigDoc, ConfigId } from "@uipi/protocol";

/** The allowlist. Nothing else may produce a filename (see configPath). */
export const CONFIG_FILES: Record<ConfigId, string> = {
  settings: "settings.json",
  roles: "roles.json",
  sandbox: "sandbox.json",
  mcp: "mcp.json",
};

/** A write lost an optimistic-concurrency race; carries the current on-disk doc. */
export class ConfigConflictError extends Error {
  readonly doc: ConfigDoc;

  constructor(doc: ConfigDoc) {
    super(`config ${doc.docId} changed on disk since it was read`);
    this.name = "ConfigConflictError";
    this.doc = doc;
  }
}

/**
 * Resolve an id to a path inside `agentDir`.
 *
 * This is the allowlist enforcement: an id that is not a key of CONFIG_FILES
 * has no mapping and throws, so an unknown/hostile id can never become a path
 * (`Object.hasOwn`, not a bare lookup, so inherited keys like `toString` cannot
 * resolve either). Callers cannot supply a filename at all.
 */
function configPath(agentDir: string, id: ConfigId): string {
  if (!Object.hasOwn(CONFIG_FILES, id)) {
    throw new Error(`unknown config id "${String(id)}"`);
  }
  return join(agentDir, CONFIG_FILES[id]);
}

/**
 * Ids that exist on disk, with their mtimes.
 *
 * Missing files are *omitted* (never reported with mtime 0): a `0` would be
 * indistinguishable from a real mtime in a conflict check, and the UI treats
 * absence as "pi has no such file yet".
 */
export async function listConfigs(agentDir: string): Promise<{ id: ConfigId; mtimeMs: number }[]> {
  const out: { id: ConfigId; mtimeMs: number }[] = [];
  for (const id of Object.keys(CONFIG_FILES) as ConfigId[]) {
    const info = await stat(configPath(agentDir, id)).catch(() => undefined);
    if (info) out.push({ id, mtimeMs: info.mtimeMs });
  }
  return out;
}

/** One document as it is on disk. Throws for an unknown id or a missing file. */
export async function readConfig(agentDir: string, id: ConfigId): Promise<ConfigDoc> {
  const path = configPath(agentDir, id);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`config ${id} does not exist: ${path}`);
  return { docId: id, mtimeMs: info.mtimeMs, text: await readFile(path, "utf8") };
}

/** Distinguishes tmp files written by concurrent saves within this process. */
let tmpCounter = 0;

/**
 * Replace `path` atomically, keeping the previous version in `<path>.bak`.
 *
 * Shared by the config store and the skill writer so both save the same way: the
 * previous content is copied to one backup slot (overwritten each save) and the
 * new text lands via a sibling tmp file + rename, so a reader never sees a
 * half-written file. The backup is only taken when there is something to back
 * up, so creating a brand-new file does not fail on a missing source.
 *
 * A target that is a symlink is refused outright: the rename would replace the
 * link itself but the backup copy would read (and `.bak` would land beside) the
 * file outside `agentDir` the link points at.
 */
export async function atomicWriteWithBackup(path: string, text: string): Promise<void> {
  const link = await lstat(path).catch(() => undefined);
  if (link?.isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${path}`);
  }

  const previous = await stat(path).catch(() => undefined);
  if (previous) await copyFile(path, `${path}.bak`);

  // The tmp name must be unique per call: with one fixed `<path>.tmp`, two
  // concurrent saves of the same document would write to (and rename away) the
  // same file, so one save would clobber or lose the other's content.
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } finally {
    // The rename consumes the tmp file; anything left here is a leaked or
    // half-written temp (failed write, failed rename, crashed predecessor), so
    // drop it rather than leaving it to block a later `rmdir` of the directory.
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Write one document back, provided nobody else touched it since `expectedMtimeMs`.
 *
 * Order matters: broken JSON is rejected before ANY disk write, a concurrent
 * edit is reported instead of clobbered, the previous version is kept as
 * `<file>.bak`, and the new content lands via tmp+rename so a reader never sees
 * a half-written file.
 */
export async function writeConfig(
  agentDir: string,
  id: ConfigId,
  expectedMtimeMs: number,
  text: string,
): Promise<ConfigDoc> {
  const path = configPath(agentDir, id);

  // (b) validation first: an unparseable doc must not cost the user their file
  try {
    JSON.parse(text);
  } catch (e) {
    throw new Error(`config ${id} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }

  // (c) optimistic concurrency — exact equality, because the client echoes back
  // the mtimeMs this module returned (a JSON double round-trips exactly)
  const current = await stat(path).catch(() => undefined);
  if (!current) throw new Error(`config ${id} does not exist: ${path}`);
  if (current.mtimeMs !== expectedMtimeMs) {
    throw new ConfigConflictError({
      docId: id,
      mtimeMs: current.mtimeMs,
      text: await readFile(path, "utf8"),
    });
  }

  // (d)+(e) one backup slot, then an atomic replace (see atomicWriteWithBackup)
  await atomicWriteWithBackup(path, text);

  // (f) report the mtime the next save must echo
  const after = await stat(path);
  return { docId: id, mtimeMs: after.mtimeMs, text };
}
