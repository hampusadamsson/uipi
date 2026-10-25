/**
 * Session URL routing: `/s/<hash8>` where hash8 is a stable FNV-1a digest of the
 * session file path. The file path is durable across reloads; the live session id
 * is not (it changes per server process), so the URL key is derived from the file.
 */

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
