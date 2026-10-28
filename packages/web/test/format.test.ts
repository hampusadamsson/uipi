// Context-token formatting shared by the message meta row, the header and the
// session list: small counts stay exact so they cannot render as "0k ctx".
import { describe, it, expect } from "vitest";
import { fmtCtx } from "../src/lib/format.js";

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
