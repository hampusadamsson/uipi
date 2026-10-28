// The skill writer is the only code allowed to turn a skill name into a path,
// so these tests pin what would be dangerous to get wrong: the slug rule (no
// traversal, no absolute paths, no spaces, no leading dot), the create/update/
// delete preconditions, and the fact that an update keeps frontmatter keys the
// caller did not send.
//
// Every case runs against a mkdtemp directory — the real ~/.pi/agent is never
// read or written here.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { writeSkill, readSkill } from "../src/skills-write.js";

const dirs: string[] = [];

/** A throwaway agent dir, removed again in afterEach. */
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uipi-skills-"));
  dirs.push(dir);
  return dir;
}

/** Path of a skill's SKILL.md inside a temp agent dir. */
function skillPath(dir: string, name: string): string {
  return join(dir, "skills", name, "SKILL.md");
}

/** Put a SKILL.md on disk directly (no writer involved). */
function seed(dir: string, name: string, text: string): string {
  const path = skillPath(dir, name);
  mkdirSync(join(dir, "skills", name), { recursive: true });
  writeFileSync(path, text);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("skill writer", () => {
  it("creates a skill and reads back the exact file", async () => {
    const dir = agentDir();

    await writeSkill(
      dir,
      "create",
      "pdf-tools",
      "description: Work with PDFs\n",
      "Do the thing.\n",
    );

    expect(readFileSync(skillPath(dir, "pdf-tools"), "utf8")).toBe(
      "---\nname: pdf-tools\ndescription: Work with PDFs\n---\n\nDo the thing.\n",
    );
  });

  it("refuses to create a skill that already exists", async () => {
    const dir = agentDir();
    const path = seed(dir, "pdf-tools", "---\nname: pdf-tools\n---\n\nold\n");

    await expect(writeSkill(dir, "create", "pdf-tools", "", "new")).rejects.toThrow(
      /already exists/,
    );

    expect(readFileSync(path, "utf8")).toBe("---\nname: pdf-tools\n---\n\nold\n");
  });

  it("reads back a skill written by the writer", async () => {
    const dir = agentDir();

    await writeSkill(dir, "create", "pdf-tools", "description: Work with PDFs", "Body line.\n");

    expect(await readSkill(dir, "pdf-tools")).toEqual({
      frontmatter: "name: pdf-tools\ndescription: Work with PDFs",
      body: "Body line.\n",
    });
  });

  it("rejects a traversal name on read without touching disk", async () => {
    const dir = agentDir();

    for (const name of ["../escape", "a/b", "/etc/passwd", ""]) {
      await expect(readSkill(dir, name)).rejects.toThrow(/invalid skill name/);
    }
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("reports a missing skill instead of returning an empty one", async () => {
    const dir = agentDir();

    await expect(readSkill(dir, "nope")).rejects.toThrow(/does not exist/);
  });

  it("refuses to update a skill that does not exist", async () => {
    const dir = agentDir();

    await expect(writeSkill(dir, "update", "nope", "description: x")).rejects.toThrow(
      /does not exist/,
    );
    expect(existsSync(skillPath(dir, "nope"))).toBe(false);
  });

  it("preserves a frontmatter key the caller omitted", async () => {
    const dir = agentDir();
    const path = seed(
      dir,
      "pdf-tools",
      "---\nname: pdf-tools\ndescription: old\nfutureKey:\n  nested: 1\n---\n\nold body\n",
    );

    await writeSkill(dir, "update", "pdf-tools", "description: new");

    expect(readFileSync(path, "utf8")).toBe(
      "---\nname: pdf-tools\ndescription: new\nfutureKey:\n  nested: 1\n---\n\nold body\n",
    );
  });

  it("deletes a skill and removes the now-empty skill dir", async () => {
    const dir = agentDir();
    seed(dir, "pdf-tools", "---\nname: pdf-tools\n---\n\nbody\n");

    await writeSkill(dir, "delete", "pdf-tools");

    expect(existsSync(skillPath(dir, "pdf-tools"))).toBe(false);
    expect(existsSync(join(dir, "skills", "pdf-tools"))).toBe(false);
    // the parent skills dir is not ours to remove
    expect(existsSync(join(dir, "skills"))).toBe(true);
  });

  it("refuses to delete a skill that does not exist", async () => {
    const dir = agentDir();

    await expect(writeSkill(dir, "delete", "nope")).rejects.toThrow(/does not exist/);
  });

  it("rejects traversal, spaces and absolute-path names without touching disk", async () => {
    const dir = agentDir();
    const bad = ["../escape", "Foo Bar", "/etc/passwd", "a/b", "..", ""];

    for (const name of bad) {
      await expect(writeSkill(dir, "create", name, "", "body")).rejects.toThrow(
        /invalid skill name/,
      );
    }

    expect(existsSync(join(dir, "escape"))).toBe(false);
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("rejects a name with a leading dot", async () => {
    const dir = agentDir();

    await expect(writeSkill(dir, "create", ".hidden", "", "body")).rejects.toThrow(
      /invalid skill name/,
    );
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("keeps the previous content in <file>.bak and leaves no .tmp behind", async () => {
    const dir = agentDir();
    const path = seed(dir, "pdf-tools", "---\nname: pdf-tools\n---\n\nold\n");

    await writeSkill(dir, "update", "pdf-tools", undefined, "new\n");

    expect(readFileSync(`${path}.bak`, "utf8")).toBe("---\nname: pdf-tools\n---\n\nold\n");
    expect(readFileSync(path, "utf8")).toBe("---\nname: pdf-tools\n---\n\nnew\n");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("round-trips a BOM-prefixed SKILL.md without folding its frontmatter into the body", async () => {
    const dir = agentDir();
    // a BOM-prefixed file with an unknown key: the splitter must still see the
    // frontmatter, or the update would treat the whole file as body and keep it
    const path = seed(
      dir,
      "pdf-tools",
      "\uFEFF---\nname: pdf-tools\ndescription: old\nfutureKey:\n  nested: 1\n---\n\nold body\n",
    );

    await writeSkill(dir, "update", "pdf-tools", "description: new");

    expect(readFileSync(path, "utf8")).toBe(
      "---\nname: pdf-tools\ndescription: new\nfutureKey:\n  nested: 1\n---\n\nold body\n",
    );
    // the body is the old body only — no second frontmatter block folded into it
    expect(await readSkill(dir, "pdf-tools")).toEqual({
      frontmatter: "name: pdf-tools\ndescription: new\nfutureKey:\n  nested: 1",
      body: "old body\n",
    });
  });

  it("round-trips a SKILL.md with lone CR newlines without duplicating frontmatter", async () => {
    const dir = agentDir();
    const path = seed(
      dir,
      "pdf-tools",
      "---\rname: pdf-tools\rdescription: old\r---\r\rold body\r",
    );

    await writeSkill(dir, "update", "pdf-tools", "description: new");

    expect(readFileSync(path, "utf8")).toBe(
      "---\nname: pdf-tools\ndescription: new\n---\n\nold body\n",
    );
  });

  it("refuses a symlinked skill dir on read, update and delete", async () => {
    const dir = agentDir();
    const outside = agentDir();
    const target = join(outside, "SKILL.md");
    const original = "---\nname: pdf-tools\n---\n\nsecret\n";
    writeFileSync(target, original);
    mkdirSync(join(dir, "skills"), { recursive: true });
    symlinkSync(outside, join(dir, "skills", "pdf-tools"), "dir");

    await expect(readSkill(dir, "pdf-tools")).rejects.toThrow(/refusing to write through symlink/);
    await expect(
      writeSkill(dir, "update", "pdf-tools", "description: x", "pwned\n"),
    ).rejects.toThrow(/refusing to write through symlink/);
    await expect(writeSkill(dir, "delete", "pdf-tools")).rejects.toThrow(
      /refusing to write through symlink/,
    );

    // the linked-to file is untouched and no backup appeared beside it
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(existsSync(`${target}.bak`)).toBe(false);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("refuses a symlinked SKILL.md even inside a real skill dir", async () => {
    const dir = agentDir();
    const outside = agentDir();
    const target = join(outside, "SKILL.md");
    writeFileSync(target, "outside\n");
    mkdirSync(join(dir, "skills", "pdf-tools"), { recursive: true });
    symlinkSync(target, skillPath(dir, "pdf-tools"));

    await expect(readSkill(dir, "pdf-tools")).rejects.toThrow(/refusing to write through symlink/);
    await expect(writeSkill(dir, "update", "pdf-tools", "description: x")).rejects.toThrow(
      /refusing to write through symlink/,
    );
    expect(readFileSync(target, "utf8")).toBe("outside\n");
  });
});
