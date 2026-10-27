/**
 * URL routing: `/s/<hash8>` for sessions (hash8 is a stable FNV-1a digest of the
 * session file path; the file path is durable across reloads, the live session id
 * is not) plus the fixed non-session pages `/skills` and `/settings`.
 */

/** The skills page route. Not a session: it has no hash to resolve. */
export const SKILLS_PAGE = "/skills";

/** The config-editing (settings) page route. Not a session either. */
export const SETTINGS_PAGE = "/settings";

/** A page that is a route of its own rather than a session. */
export type PageId = "skills" | "settings";

/** True for routes that are pages of their own rather than a session. */
export function isPagePath(p: string): boolean {
  return p === SKILLS_PAGE || p === SETTINGS_PAGE;
}

/** The page a path names, or null when it is not a page route. */
export function pageIdFromPath(p: string): PageId | null {
  if (p === SKILLS_PAGE) return "skills";
  if (p === SETTINGS_PAGE) return "settings";
  return null;
}

export function hash8(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** URL path for a session file, or "/" for none */
export function pathFor(sessionFile: string | null | undefined): string {
  return sessionFile ? `/s/${hash8(sessionFile)}` : "/";
}

/** hash from a URL path, or undefined when the path is not a session route */
export function hashFromPath(pathname: string): string | undefined {
  return /^\/s\/([0-9a-f]{8})$/.exec(pathname)?.[1];
}
