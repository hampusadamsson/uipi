/** The usage fields that add up to a message's context size. */
export interface ContextUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Context size after a message: `input + cacheRead + cacheWrite`, with missing
 * fields counting as zero. Shared by the session-wide counter in
 * {@link UipiClient} and the per-message `metaOf`, so both agree by construction.
 */
export function contextTokensOf(usage: ContextUsage): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}
