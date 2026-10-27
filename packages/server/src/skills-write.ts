// Create / update / delete of one user skill inside `<agentDir>/skills/<name>/`.
//
// The client never names a path: `name` must be a lowercase slug, and the only
// file this module can ever touch is `<agentDir>/skills/<name>/SKILL.md`. The
// slug rule is the primary defence (it has no `/`, no `..`, no spaces and no
// leading dot); the resolved-path check afterwards is defence in depth, the same
// idiom `config.ts` uses.
//
// Frontmatter is treated as opaque text so unknown keys written by a newer (or
// older) pi survive an edit through the web UI. On update the merge is done on
// raw lines: `@uipi/server` has no YAML parser dependency (see package.json) and
// adding one just to keep unknown keys would be a heavier change than the job
// needs — a line-based merge is exact for the flat frontmatter skills use.
import { mkdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { atomicWriteWithBackup } from "./config.js";

export type SkillWriteOp = "create" | "update" | "delete";

/** Lowercase slug: no `/`, no `..` traversal, no spaces, no leading dot. */
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LENGTH = 64;

/** Reject anything that is not a plain skill slug (see SKILL_NAME). */
function assertSkillName(name: string): void {
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`invalid skill name "${name}": longer than ${MAX_NAME_LENGTH} characters`);
  }
  if (!SKILL_NAME.test(name)) {
    throw new Error(
      `invalid skill name "${name}": must match ${SKILL_NAME.source} ` +
        `(lowercase slug, max ${MAX_NAME_LENGTH} chars)`,
    );
  }
}

/**
 * Resolve a skill name to its SKILL.md.
 *
 * The path is always `join(agentDir, "skills", name, "SKILL.md")`; after
 * resolving, the result must still sit inside the resolved skills dir, so even a
 * slug rule that some future refactor relaxes cannot escape the directory.
 */
function skillFile(agentDir: string, name: string): string {
  assertSkillName(name);

  const skillsDir = resolve(join(agentDir, "skills"));
  const path = resolve(join(skillsDir, name, "SKILL.md"));
  if (!path.startsWith(skillsDir + sep)) {
    throw new Error(`invalid skill name "${name}": resolves outside ${skillsDir}`);
  }
  return path;
}

/** Normalise only the outer blank lines a textarea tends to add; nothing else. */
function trimBlankLines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/** One assembled SKILL.md: frontmatter block, blank line, body. */
function renderSkill(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

/** The `key` of a top-level frontmatter line, or undefined for comments/blanks. */
function frontmatterKey(line: string): string | undefined {
  const m = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
  return m?.[1];
}

/**
 * Split frontmatter text into blocks: one block per top-level `key:` line plus
 * the indented continuation lines that belong to it, so a kept key keeps its
 * whole value (a YAML list, a nested mapping) and not just its first line.
 */
function frontmatterBlocks(frontmatter: string): { key: string | undefined; lines: string[] }[] {
  const blocks: { key: string | undefined; lines: string[] }[] = [];
  for (const line of frontmatter.split("\n")) {
    const key = frontmatterKey(line);
    const last = blocks.at(-1);
    const continuation = /^([ \t]|-\s|$)/.test(line) && last !== undefined;
    if (key !== undefined || !continuation) {
      blocks.push({ key, lines: [line] });
    } else {
      last.lines.push(line);
    }
  }
  return blocks;
}

/** Split an existing SKILL.md into its raw frontmatter lines and its body. */
function splitSkill(text: string): { frontmatter: string; body: string } {
  const normalised = text.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return { frontmatter: "", body: normalised };
  const end = normalised.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: normalised };
  const frontmatter = normalised.slice(4, end);
  const rest = normalised.slice(end + 4).replace(/^\n+/, "");
  return { frontmatter, body: rest };
}

/**
 * Keep every disk frontmatter block whose key the caller did not supply.
 *
 * Raw-line merge: keys are matched on their top-level `key:` line only, so
 * unknown keys and their nested values survive verbatim, while a key the caller
 * does supply is taken from the caller's text as-is.
 */
function mergeFrontmatter(disk: string, incoming: string): string {
  const incomingKeys = new Set(
    frontmatterBlocks(incoming)
      .map((b) => b.key)
      .filter((k): k is string => k !== undefined),
  );
  const kept = frontmatterBlocks(disk)
    .filter((b) => b.key !== undefined && !incomingKeys.has(b.key))
    .flatMap((b) => b.lines);
  if (kept.length === 0) return incoming;
  return incoming.length > 0 ? `${incoming}\n${kept.join("\n")}` : kept.join("\n");
}

/** Insert `name:` first when the caller's frontmatter does not already set it. */
function withName(frontmatter: string, name: string): string {
  const hasName = frontmatterBlocks(frontmatter).some((b) => b.key === "name");
  return hasName ? frontmatter : frontmatter ? `name: ${name}\n${frontmatter}` : `name: ${name}`;
}

/**
 * Read `<agentDir>/skills/<name>/SKILL.md` back as raw frontmatter + body.
 *
 * Same name validation and containment check as {@link writeSkill}, so a read can
 * never reach outside the skills dir either. Throws when the skill has no file
 * on disk — the caller reports that as an ordinary error, not an empty skill.
 */
export async function readSkill(
  agentDir: string,
  name: string,
): Promise<{ frontmatter: string; body: string }> {
  const path = skillFile(agentDir, name);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`skill ${name} does not exist: ${path}`);
  }
  return splitSkill(text);
}

/**
 * Create, update or delete `<agentDir>/skills/<name>/SKILL.md`.
 *
 * `create` refuses an existing skill, `update` refuses a missing one and keeps
 * any frontmatter key the caller omitted (as well as the body, when `body` is
 * not supplied), and `delete` refuses a missing one. Writes go through the same
 * backup + tmp/rename path as the config store.
 */
export async function writeSkill(
  agentDir: string,
  op: SkillWriteOp,
  name: string,
  frontmatter?: string,
  body?: string,
): Promise<void> {
  const path = skillFile(agentDir, name);
  const exists = (await stat(path).catch(() => undefined)) !== undefined;
  const incoming = trimBlankLines(frontmatter ?? "");

  if (op === "delete") {
    if (!exists) throw new Error(`skill ${name} does not exist: ${path}`);
    await rm(path);
    // only the now-empty skill dir goes away; a dir with other files stays
    await rmdir(join(path, "..")).catch(() => {});
    return;
  }

  if (op === "create") {
    if (exists) throw new Error(`skill ${name} already exists: ${path}`);
    await mkdir(join(agentDir, "skills", name), { recursive: true });
    await atomicWriteWithBackup(path, renderSkill(withName(incoming, name), body ?? ""));
    return;
  }

  if (op === "update") {
    if (!exists) throw new Error(`skill ${name} does not exist: ${path}`);
    const disk = splitSkill(await readFile(path, "utf8"));
    // name first, before the merge, so a kept-on-disk `name:` line cannot land
    // after the caller's keys: supplying it means the merge drops the disk one
    const merged = mergeFrontmatter(disk.frontmatter, withName(incoming, name));
    await atomicWriteWithBackup(path, renderSkill(merged, body ?? disk.body));
    return;
  }

  throw new Error(`unknown skill operation "${String(op)}"`);
}
