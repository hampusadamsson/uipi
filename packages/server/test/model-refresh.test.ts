// A new session must refresh its provider model catalogs over the network.
//
// The bug this pins: `createAgentSessionServices` builds the runtime with
// `refresh({ allowNetwork: false })`, so a session inherits whatever catalog was
// last written to disk by *some other* pi process. uipi never refreshed over the
// network, so a Bifrost list written days earlier was served forever — including
// a bare `qwen/qwen3.5-9b` id whose upstream had since been renamed, which
// Bifrost cannot route. Picking it failed the turn with
// "could not auto resolve a provider for the request".
//
// The property: materializing a session asks for a network refresh, and a failed
// refresh degrades to the cache instead of failing the session.
import { describe, it, expect, vi } from "vitest";
import { refreshModelCatalog } from "../src/sessions.js";

describe("refreshModelCatalog", () => {
  it("asks for a network refresh", async () => {
    const refresh = vi.fn().mockResolvedValue({ aborted: false, errors: {} });

    await refreshModelCatalog({ refresh });

    expect(refresh).toHaveBeenCalledTimes(1);
    // without allowNetwork the provider answers from its on-disk cache, which is
    // exactly the stale list this exists to replace
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: true });
  });

  it("swallows a refresh failure so the session still opens", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(refreshModelCatalog({ refresh })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("model catalog refresh failed"));
    warn.mockRestore();
  });

  it("is a no-op when the runtime has no refresh (a minimal or fake session)", async () => {
    await expect(refreshModelCatalog(undefined)).resolves.toBeUndefined();
    await expect(
      refreshModelCatalog({} as unknown as { refresh: () => Promise<unknown> }),
    ).resolves.toBeUndefined();
  });
});
