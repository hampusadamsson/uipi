/**
 * Model *references* — the pair pi actually identifies a model by.
 *
 * A model is `provider` + `modelId`, never a model id on its own: `bifrost`
 * serves `opencode-go/deepseek-v4.1-flash` while a native `opencode-go`
 * provider could serve the same `deepseek-v4.1-flash`, and two providers
 * routinely ship the same id. Anything that compares, keys or flags a model by
 * `modelId` alone therefore picks the wrong row as soon as the list carries
 * more than one provider — which is exactly what the picker did.
 *
 * These helpers are the single definition of that identity so the highlight,
 * the row keys and the "is this the current model" test cannot drift apart.
 */

/** The parts of a model this module needs; `ModelInfo` and an attached session's
 *  `model` both satisfy it, so either can be passed in. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** A stable, collision-free key for one model reference (`provider/modelId`). */
export function modelRefKey(m: ModelRef): string {
  return `${m.provider}/${m.modelId}`;
}

/**
 * True when two references name the same model.
 *
 * `null`/`undefined` mean "no model", so two absences are *not* a match: an
 * unattached session must not mark every row current. Both parts are compared —
 * this is the fix for a bare `modelId === modelId` check.
 */
export function sameModelRef(
  a: ModelRef | null | undefined,
  b: ModelRef | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * The upstream routing prefix Bifrost puts in front of a model id
 * (`opencode-go/deepseek-v4.1-flash` → `opencode-go`), or `null` when the id is
 * bare.
 *
 * Bifrost prefixes every id with the upstream provider it routes to, and that
 * prefix — not `bifrost` — is the useful grouping label in the picker.
 */
export function upstreamPrefix(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : null;
}

/**
 * The row's primary label.
 *
 * `displayName` is the name to show. A bare reference (an attached session's
 * `model`, which carries no name) keeps its full id: the routing prefix is part
 * of the id, and dropping it is how two upstreams serving one model name get
 * confused for each other.
 *
 * A *discovered* model that reports no metadata gets its id as the name
 * (Bifrost answers a local upstream with just `{id}`), so `lmstudio/qwen3.5-9b-mlx`
 * would be printed as a name and then again in the id line. Strip the upstream
 * prefix in that case, so the label is the model, not its route.
 */
export function modelLabel(m: ModelRef & { displayName?: string }): string {
  const name = typeof m.displayName === "string" ? m.displayName : "";
  if (!name) return m.modelId;
  if (name !== m.modelId) return name;
  const prefix = upstreamPrefix(m.modelId);
  return prefix !== null ? m.modelId.slice(prefix.length + 1) : m.modelId;
}

/**
 * The row's secondary line: which provider serves it.
 *
 * Every Bifrost model shares `provider: "bifrost"`, so printing only that 35
 * times says nothing. The routing prefix is what distinguishes them, so it is
 * appended when it is not already the provider.
 */
export function modelSubtitle(m: ModelRef): string {
  const prefix = upstreamPrefix(m.modelId);
  return prefix && prefix !== m.provider ? `${m.provider} · ${prefix}` : m.provider;
}
