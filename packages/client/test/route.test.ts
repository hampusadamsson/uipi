import { describe, it, expect } from "vitest";
import { hash8, pathFor, hashFromPath } from "../src/route.js";

describe("session URL routing", () => {
  const file = "/Users/hampus/.pi/agent/sessions/--tmp--/2026-10-25T09-13-59-697Z_01a1.jsonl";

  it("hash8 is stable, 8 hex chars, and differs per path", () => {
    const h = hash8(file);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(hash8(file)).toBe(h);
    expect(hash8(file + "x")).not.toBe(h);
  });

  it("builds /s/<hash> for a session file", () => {
    expect(pathFor(file)).toBe(`/s/${hash8(file)}`);
  });

  it("returns / when there is no session file", () => {
    expect(pathFor(null)).toBe("/");
    expect(pathFor(undefined)).toBe("/");
  });

  it("round-trips path -> hash", () => {
    expect(hashFromPath(pathFor(file))).toBe(hash8(file));
  });

  it("ignores non-session paths", () => {
    expect(hashFromPath("/")).toBeUndefined();
    expect(hashFromPath("/s/nope")).toBeUndefined();
    expect(hashFromPath("/s/0123456789")).toBeUndefined();
    expect(hashFromPath("/other/abcdef12")).toBeUndefined();
  });
});
