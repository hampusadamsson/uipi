// Context-token formatting shared by the message meta row, the header and the
// session list: small counts stay exact so they cannot render as "0k ctx".
import { describe, it, expect } from "vitest";
import { fmtCtx, fmtTime } from "../src/lib/format.js";

describe("fmtCtx", () => {
  it("keeps sub-thousand counts exact", () => {
    expect(fmtCtx(850)).toBe("850 ctx");
    expect(fmtCtx(999)).toBe("999 ctx");
  });

  it("rounds thousands and up to Nk", () => {
    expect(fmtCtx(1000)).toBe("1k ctx");
    expect(fmtCtx(12_400)).toBe("12k ctx");
  });
});

describe("fmtTime", () => {
  /** a local-time Date, so the assertions do not depend on the test machine's zone */
  const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
    new Date(y, mo - 1, d, h, mi).getTime();

  it("shows just the wall clock for a message from today", () => {
    const now = new Date();
    expect(fmtTime(at(now.getFullYear(), now.getMonth() + 1, now.getDate(), 9, 5))).toBe("09:05");
  });

  it("adds the date for anything older", () => {
    const now = new Date();
    expect(fmtTime(at(now.getFullYear() - 1, 12, 19, 14, 32))).toBe("Dec 19 14:32");
  });

  it("returns nothing for an unparseable time", () => {
    expect(fmtTime(Number.NaN)).toBe("");
  });
});
