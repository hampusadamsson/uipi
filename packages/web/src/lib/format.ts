/**
 * Format a context-token count for display: `850 ctx` below 1k, `12k ctx` above.
 *
 * Below 1k the rounded form would read "0k ctx", so the exact count is shown.
 */
export function fmtCtx(n: number): string {
  return n < 1000 ? `${Math.round(n)} ctx` : `${Math.round(n / 1000)}k ctx`;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * Format a message timestamp (unix ms) as a wall-clock time in the reader's own
 * zone: `14:32` for today, `Nov 19 14:32` for anything older.
 *
 * The date is only spelled out when it adds information — a same-day transcript
 * is the common case, and repeating the date on every row is noise. Locale is
 * pinned to `en-US` rather than the browser's so the format stays one shape.
 */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day} ${time}`;
}
