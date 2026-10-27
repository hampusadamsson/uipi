import { Marked, type RendererObject } from "marked";
import { highlighter, resolveLanguage } from "./highlight.js";

/**
 * Markdown → HTML for chat messages.
 *
 * Two deliberate deviations from marked's defaults, both because the input is
 * *model output*, not trusted authoring:
 *
 *  1. **Raw HTML is escaped, never passed through.** marked hands `<script>` and
 *     friends to the page verbatim by default; a prompt-injected page the agent
 *     read would then be able to run script in the UI. Escaping keeps the text
 *     visible and inert. (No DOM sanitiser dependency needed for a rule this
 *     simple: there is no HTML we want to keep.)
 *  2. **Links and images are URL-vetted.** `javascript:`/`data:`/`vbscript:`
 *     destinations are dropped, and links open in a new tab with `noopener`, so
 *     clicking one in a transcript can't navigate the app away or script it.
 *
 * Everything else is GFM as marked ships it, plus `breaks: true`: chat input has
 * always preserved single newlines (`whitespace-pre-wrap`), so a line break must
 * stay a line break.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Decode the HTML character references that can hide a scheme separator.
 * `javascript&#58;alert(1)` reaches the renderer as that literal text (marked
 * does not decode it), so a scheme check that ran on it verbatim would see no
 * colon at all and let it through. Only the references that matter for schemes
 * are handled — a general entity decoder is not needed to answer this question.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d{1,7});?/g, (_m, dec: string) => safeFromCode(Number(dec)))
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&(colon|tab|newline|sol|bsol);/gi, (_m, name: string) => {
      const map: Record<string, string> = {
        colon: ":",
        tab: "\t",
        newline: "\n",
        sol: "/",
        bsol: "\\",
      };
      return map[name.toLowerCase()] ?? _m;
    });
}

/** Code point → character, or "" for anything that is not a plausible separator. */
function safeFromCode(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** Drop C0 controls and DEL — browsers ignore them inside URLs, so they can
 *  split a scheme (`java\tscript:`) past a naive check. Character comparison,
 *  not a regex: a control-character regex is a lint error for good reason. */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * A URL that is safe to put in `href`/`src`, or null. Unknown schemes are
 * dropped rather than guessed at; bare relative paths are allowed because
 * `target="_blank"` keeps them from replacing the app.
 */
function safeUrl(raw: string): string | null {
  const url = stripControl(decodeEntities(raw)).trim();
  if (!url) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme) return ["http", "https", "mailto"].includes(scheme) ? url : null;
  // protocol-relative is a URL, not a path: "//evil.example", plus the
  // "/\\" and "\\/\\" spellings a browser normalises to the same thing
  return /^[\\/]{2}/.test(url) ? null : url;
}

/** Theme-consistent `hljs-*` classes, styled in app.css (no external stylesheet). */
function highlight(code: string, tag: string | undefined): string {
  const lang = resolveLanguage(tag);
  if (lang) {
    try {
      return highlighter.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through to plain */
    }
  }
  return escapeHtml(code);
}

const renderer: RendererObject = {
  // raw HTML: show it, don't run it
  html({ text }) {
    return escapeHtml(text);
  },
  code({ text, lang }) {
    const cls = lang?.trim() ? ` class="language-${escapeHtml(lang.trim().split(/\s+/)[0])}"` : "";
    return `<pre><code class="hljs"${cls}>${highlight(text, lang)}</code></pre>`;
  },
  link({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const url = safeUrl(href);
    // an unsafe destination keeps its text but loses the click target
    if (!url) return `<span>${text}</span>`;
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
  image({ href, title, text }) {
    const url = safeUrl(href);
    if (!url) return escapeHtml(text);
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${t} loading="lazy" referrerpolicy="no-referrer" />`;
  },
};

const md = new Marked({ gfm: true, breaks: true, renderer });

/**
 * Parse cache. Streaming re-renders the last message on every delta, and
 * `deriveTranscript` recomputes the whole transcript on any change, so the same
 * text is parsed repeatedly. Bounded so a long session can't grow it forever.
 */
const CACHE_MAX = 500;
const cache = new Map<string, string>();

/** Render markdown to sanitized HTML. Same input → same output (cached). */
export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = md.parse(src, { async: false });
  } catch {
    // a parse failure must never blank a message: show it verbatim
    html = `<p>${escapeHtml(src)}</p>`;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(src, html);
  return html;
}
