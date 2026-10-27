import hljs from "highlight.js/lib/core";

/**
 * Explicit language set.
 *
 * `highlight.js/lib/common` is ~40 grammars and cost ~200 kB of the bundle for
 * languages a chat transcript never shows. This is the working set for code
 * an agent writes: shell/tooling, the mainstream languages, plus the config
 * formats that show up in diffs. Anything else renders as plain escaped code
 * (see `highlight` below), which is the correct degradation — an unknown fence
 * tag must never break a message.
 *
 * Adding a language means one import + one `registerLanguage` line.
 */
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, def] of Object.entries(languages)) hljs.registerLanguage(name, def);

// Fence tags models actually write that differ from hljs's registration name.
const aliases: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  htm: "xml",
  docker: "dockerfile",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  md: "markdown",
  kt: "kotlin",
  toml: "ini",
  patch: "diff",
  jsonc: "json",
};

/** Resolve a fence tag to a registered language, or null when it is unknown. */
export function resolveLanguage(tag: string | undefined): string | null {
  const name = tag?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!name) return null;
  const resolved = aliases[name] ?? name;
  return hljs.getLanguage(resolved) ? resolved : null;
}

/** highlight.js instance with the languages above registered. */
export const highlighter = hljs;
