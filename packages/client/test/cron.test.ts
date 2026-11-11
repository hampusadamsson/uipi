// `describeCron` is display-only: it turns a cron expression into the short phrase
// the UI shows next to a schedule. Only the documented shapes are described; the
// rest falls back to `cron <expr>` so the UI never claims more than it knows.
import { describe, it, expect } from "vitest";
import { describeCron } from "../src/cron.js";

describe("describeCron", () => {
  it("describes the documented shapes", () => {
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("every hour at :00");
    expect(describeCron("0 9 * * *")).toBe("daily at 09:00");
    expect(describeCron("30 8 * * 1-5")).toBe("weekdays at 08:30");
    expect(describeCron("0 6 * * 1")).toBe("every Monday at 06:00");
    expect(describeCron("0 0 1 * *")).toBe("monthly on the 1st at 00:00");
    // a restricted day-of-month is described as monthly, not daily
    expect(describeCron("0 9 30 * *")).toBe("monthly on the 30th at 09:00");
  });

  it("falls back to a generic phrase for anything else", () => {
    expect(describeCron("*/5 9-17 * * *")).toBe("cron */5 9-17 * * *");
    expect(describeCron("not a cron")).toBe("cron not a cron");
  });
});
