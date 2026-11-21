// A custom provider from `models.json` reaches the picker unchanged.
//
// This is the pi feature that user-defined provider setup depends on: a
// `models.json` `providers` entry (Bifrost, in this agent dir) is a provider,
// not an extension. Nothing in uipi may filter, hardcode or re-order it — the
// list is pi's model runtime, read through `modelRuntime.getAvailableSnapshot()`
// and forwarded as-is. If a future pi version renames the API or the snapshot
// shape, this fails instead of silently emptying the picker.
import { describe, it, expect } from "vitest";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway agent dir holding one models.json provider, like ~/.pi/agent. */
function agentDirWithProvider(): { agentDir: string; cwd: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "uipi-provider-"));
  const cwd = mkdtempSync(join(tmpdir(), "uipi-cwd-"));
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      $schema: "https://pi.dev/schemas/models.schema.json",
      providers: {
        cuprov: {
          name: "Custom Provider",
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "$CUSTOM_PROVIDER_API_KEY",
          authHeader: true,
          compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
          models: [
            {
              id: "vendor/model-a",
              reasoning: true,
              contextWindow: 32768,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  // `getAvailableSnapshot()` lists only providers pi can actually authenticate,
  // which for a models.json provider means a stored credential — the same
  // `auth.json` entry `/login` or a hand-written key leaves behind.
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ cuprov: { type: "api_key", key: "sk-test-not-a-real-key" } }),
  );
  return { agentDir, cwd };
}

describe("models.json provider reaches the model list", () => {
  it("is available from pi's runtime under its own provider id", async () => {
    const { agentDir, cwd } = agentDirWithProvider();
    const services = await createAgentSessionServices({ cwd, agentDir });
    const snapshot = services.modelRuntime.getAvailableSnapshot() as unknown as {
      provider: string;
      id: string;
    }[];

    const custom = snapshot.filter((m) => String(m.provider) === "cuprov");
    expect(custom.map((m) => String(m.id))).toEqual(["vendor/model-a"]);
  });

  it("is resolvable by provider + model id, the way pi.setModel asks for it", async () => {
    const { agentDir, cwd } = agentDirWithProvider();
    const services = await createAgentSessionServices({ cwd, agentDir });

    const model = services.modelRuntime.getModel("cuprov", "vendor/model-a");
    expect(model).toBeDefined();
    // an unknown pair stays unknown: no fuzzy fallback that would let a stale
    // picker row run against a different provider
    expect(services.modelRuntime.getModel("cuprov", "vendor/nope")).toBeUndefined();
  });
});
