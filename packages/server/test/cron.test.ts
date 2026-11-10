// The cron engine is hand-rolled (no new npm deps), so these tests pin the parts
// that are easy to get subtly wrong: field bounds, name aliases, the OR rule
// between day-of-month and day-of-week, and that `nextRunAt` walks in LOCAL time.
//
// Every `from` and every expected value is built from local-time components
// (`new Date(y, m, d, h, min)`), so the assertions hold in any timezone and never
// depend on the current clock.
import { describe, it, expect } from "vitest";
import { isValidCron, nextRunAt, parseCron } from "../src/cron.js";

/** Next run for `expr` strictly after `from`. */
function next(expr: string, from: Date): Date {
  return nextRunAt(parseCron(expr), from);
}

describe("parseCron", () => {
  it("expands *, ranges, lists and steps", () => {
    const every15 = parseCron("*/15 * * * *");
    expect([...every15.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);

    const stepped = parseCron("5-20/5 1,5,9 * * *");
    expect([...stepped.minute].sort((a, b) => a - b)).toEqual([5, 10, 15, 20]);
    expect([...stepped.hour].sort((a, b) => a - b)).toEqual([1, 5, 9]);

    expect([...parseCron("0 9 1-3 1-12 *").dayOfMonth].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("accepts month and weekday names, case-insensitively", () => {
    expect([...parseCron("0 0 * jan,Jul *").month].sort((a, b) => a - b)).toEqual([1, 7]);
    expect([...parseCron("0 0 * * mon-fri").dayOfWeek].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect([...parseCron("0 0 * * SUN").dayOfWeek]).toEqual([0]);
  });

  it("treats both 0 and 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7").dayOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 0").dayOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 5-7").dayOfWeek].sort((a, b) => a - b)).toEqual([0, 5, 6]);
  });

  it("records which day fields were restricted", () => {
    expect(parseCron("* * * * *")).toMatchObject({ domRestricted: false, dowRestricted: false });
    expect(parseCron("0 0 13 * *")).toMatchObject({ domRestricted: true, dowRestricted: false });
    expect(parseCron("0 0 * * 5")).toMatchObject({ domRestricted: false, dowRestricted: true });
    expect(parseCron("0 0 13 * 5")).toMatchObject({ domRestricted: true, dowRestricted: true });
  });

  it("rejects invalid expressions with a clear message", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/minute field value 60 is out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/hour field value 24 is out of range/);
    expect(() => parseCron("* * *")).toThrow(/needs 5 fields, got 3/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step must be at least 1/);
    expect(() => parseCron("abc * * * *")).toThrow(/invalid value: "abc"/);
    expect(() => parseCron("* * 0 * *")).toThrow(/day-of-month field value 0 is out of range/);
    expect(() => parseCron("* * * 13 *")).toThrow(/month field value 13 is out of range/);
    expect(() => parseCron("* * * * 8")).toThrow(/day-of-week field value 8 is out of range/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/range is reversed/);
    expect(() => parseCron("* * * *")).toThrow(/needs 5 fields/);
  });

  it("isValidCron mirrors parseCron", () => {
    expect(isValidCron("*/15 * * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("nope")).toBe(false);
  });
});

describe("nextRunAt", () => {
  it("finds the next quarter hour for */15 * * * *", () => {
    const from = new Date(2024, 4, 15, 10, 7, 30); // Wed 15 May 2024, 10:07:30 local
    expect(next("*/15 * * * *", from)).toEqual(new Date(2024, 4, 15, 10, 15));

    // exactly on a boundary the next one is taken, not the same instant
    expect(next("*/15 * * * *", new Date(2024, 4, 15, 10, 15))).toEqual(
      new Date(2024, 4, 15, 10, 30),
    );
    // and rolls over the hour
    expect(next("*/15 * * * *", new Date(2024, 4, 15, 10, 50))).toEqual(
      new Date(2024, 4, 15, 11, 0),
    );
  });

  it("rolls a daily schedule across midnight", () => {
    const from = new Date(2024, 4, 15, 23, 45); // Wed 15 May 2024
    expect(next("0 9 * * *", from)).toEqual(new Date(2024, 4, 16, 9, 0));
  });

  it("rolls a monthly schedule into the next month", () => {
    const from = new Date(2024, 0, 15, 12, 0); // 15 Jan 2024
    expect(next("0 0 1 * *", from)).toEqual(new Date(2024, 1, 1, 0, 0));
  });

  it("rolls a yearly schedule into the next year", () => {
    const from = new Date(2024, 5, 1, 0, 0); // 1 Jun 2024
    expect(next("0 0 1 1 *", from)).toEqual(new Date(2025, 0, 1, 0, 0));
  });

  it("skips the weekend for 30 8 * * 1-5", () => {
    const from = new Date(2024, 4, 17, 18, 0); // Friday 17 May 2024, evening
    expect(from.getDay()).toBe(5);
    const run = next("30 8 * * 1-5", from);
    expect(run).toEqual(new Date(2024, 4, 20, 8, 30)); // Monday
    expect(run.getDay()).toBe(1);
  });

  it("applies the OR rule when both day fields are restricted", () => {
    const fields = parseCron("0 0 13 * 5");

    // Thu 9 May 2024 → next match is Friday the 10th (weekday rule)
    expect(nextRunAt(fields, new Date(2024, 4, 9, 12, 0))).toEqual(new Date(2024, 4, 10, 0, 0));

    // Sat 11 May 2024 → next match is Monday the 13th (day-of-month rule)
    expect(nextRunAt(fields, new Date(2024, 4, 11, 12, 0))).toEqual(new Date(2024, 4, 13, 0, 0));

    // and only one of the two restricted means only that one applies
    const domOnly = parseCron("0 0 13 * *");
    expect(nextRunAt(domOnly, new Date(2024, 4, 10, 0, 0))).toEqual(new Date(2024, 4, 13, 0, 0));
    const dowOnly = parseCron("0 0 * * 5");
    expect(nextRunAt(dowOnly, new Date(2024, 4, 10, 0, 0))).toEqual(new Date(2024, 4, 17, 0, 0));
  });

  it("throws when nothing ever matches", () => {
    expect(() => next("0 0 30 2 *", new Date(2024, 0, 1, 0, 0))).toThrow(/no upcoming run/);
  });

  it("stays on local wall-clock time for a fixed from", () => {
    const from = new Date(2024, 11, 31, 23, 59); // 31 Dec 2024, last minute of the year
    const run = next("0 0 1 * *", from);
    expect(run.getFullYear()).toBe(2025);
    expect(run.getMonth()).toBe(0);
    expect(run.getDate()).toBe(1);
    expect(run.getHours()).toBe(0);
    expect(run.getMinutes()).toBe(0);
  });
});
