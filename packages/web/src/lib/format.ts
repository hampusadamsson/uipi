/**
 * Format a context-token count for display: `850 ctx` below 1k, `12k ctx` above.
 *
 * Below 1k the rounded form would read "0k ctx", so the exact count is shown.
 */
export function fmtCtx(n: number): string {
  return n < 1000 ? `${Math.round(n)} ctx` : `${Math.round(n / 1000)}k ctx`;
}
