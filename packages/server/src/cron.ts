// A dependency-free 5-field cron engine (`minute hour day-of-month month day-of-week`).
//
// The monorepo keeps its dependency set pinned, so this is hand-rolled rather than
// pulled from npm. It covers what the UI schedules use — `*`, lists, ranges, steps,
// month/weekday names, and `7` as a second spelling of Sunday — and nothing more.
// Anything it does not understand is rejected with a thrown Error instead of being
// silently ignored: a schedule that parses must mean exactly what the user typed.
//
// `nextRunAt` evaluates in LOCAL time (via the Date local-time constructors), which
// is what a person writing "daily at 09:00" means. It walks forward field by field
// (month → day → hour → minute) rather than minute by minute, and gives up after
// ~4 years so an impossible schedule (`0 0 30 2 *`) throws instead of looping.

/** A parsed expression: the expanded value sets plus the OR-rule information. */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /**
   * True when the field text did not start with `*` (so `1`, `1-5`, `MON-FRI`, ...).
   * The standard cron rule needs this: when BOTH day fields are restricted, a day
   * matches if EITHER matches; when only one is restricted, only that one applies.
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/** Shape of one cron field: its bounds, its optional names, and how to normalize 7→0. */
interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** Highest literal value accepted before normalization (day-of-week accepts 7). */
  rawMax: number;
  names?: Record<string, number>;
  normalize?: (value: number) => number;
}

const FIELDS: readonly [FieldSpec, keyof Omit<CronFields, "domRestricted" | "dowRestricted">][] = [
  [{ name: "minute", min: 0, max: 59, rawMax: 59 }, "minute"],
  [{ name: "hour", min: 0, max: 23, rawMax: 23 }, "hour"],
  [{ name: "day-of-month", min: 1, max: 31, rawMax: 31 }, "dayOfMonth"],
  [{ name: "month", min: 1, max: 12, rawMax: 12, names: MONTH_NAMES }, "month"],
  [
    {
      name: "day-of-week",
      min: 0,
      max: 6,
      rawMax: 7,
      names: WEEKDAY_NAMES,
      normalize: (value: number) => (value === 7 ? 0 : value),
    },
    "dayOfWeek",
  ],
];

/** Parse one literal: a number, or a name in a field that has names. */
function parseValue(token: string, spec: FieldSpec): number {
  if (token === "") throw new Error(`${spec.name} field has an empty value`);

  const name = spec.names?.[token.toUpperCase()];
  if (name !== undefined) return name;

  if (!/^\d+$/.test(token)) {
    throw new Error(`${spec.name} field has an invalid value: "${token}"`);
  }
  const value = Number(token);
  if (value < spec.min || value > spec.rawMax) {
    throw new Error(
      `${spec.name} field value ${value} is out of range (${spec.min}-${spec.rawMax})`,
    );
  }
  return value;
}

/** Parse one comma-separated segment into `out`. */
function parseSegment(segment: string, spec: FieldSpec, out: Set<number>): void {
  const parts = segment.split("/");
  if (parts.length > 2) {
    throw new Error(`${spec.name} field has too many "/" in "${segment}"`);
  }

  let step = 1;
  if (parts.length === 2) {
    const stepText = parts[1] ?? "";
    if (!/^\d+$/.test(stepText)) {
      throw new Error(`${spec.name} field has an invalid step: "${stepText}"`);
    }
    step = Number(stepText);
    if (step < 1) {
      throw new Error(`${spec.name} field step must be at least 1 (got ${step})`);
    }
  }

  const base = parts[0] ?? "";
  let start: number;
  let end: number;

  if (base === "*") {
    start = spec.min;
    end = spec.max;
  } else {
    const dash = base.split("-");
    if (dash.length > 2) {
      throw new Error(`${spec.name} field has an invalid range: "${base}"`);
    }
    if (dash.length === 2) {
      start = parseValue(dash[0] ?? "", spec);
      end = parseValue(dash[1] ?? "", spec);
      if (start > end) {
        throw new Error(`${spec.name} field range is reversed: "${base}"`);
      }
    } else {
      if (parts.length === 2) {
        throw new Error(`${spec.name} field step needs a range or "*": "${segment}"`);
      }
      start = parseValue(base, spec);
      end = start;
    }
  }

  for (let value = start; value <= end; value += step) {
    const normalized = spec.normalize ? spec.normalize(value) : value;
    if (normalized < spec.min || normalized > spec.max) {
      throw new Error(`${spec.name} field value ${value} is out of range`);
    }
    out.add(normalized);
  }
}

/**
 * Parse a 5-field cron expression (minute, hour, day-of-month, month, day-of-week).
 * Throws an Error describing the first problem found; nothing is guessed.
 */
export function parseCron(expr: string): CronFields {
  if (typeof expr !== "string") throw new Error("cron expression must be a string");

  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression needs 5 fields, got ${fields.length}: "${expr}"`);
  }

  const sets: Record<string, Set<number>> = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const [spec, key] = FIELDS[i]!;
    const text = fields[i]!;
    const values = new Set<number>();
    for (const segment of text.split(",")) parseSegment(segment, spec, values);
    if (values.size === 0) throw new Error(`${spec.name} field matches nothing: "${text}"`);
    sets[key] = values;
  }

  return {
    minute: sets.minute!,
    hour: sets.hour!,
    dayOfMonth: sets.dayOfMonth!,
    month: sets.month!,
    dayOfWeek: sets.dayOfWeek!,
    domRestricted: !fields[2]!.startsWith("*"),
    dowRestricted: !fields[4]!.startsWith("*"),
  };
}

/** Roughly four years, in milliseconds: the "no upcoming run" horizon. */
const HORIZON_MS = 4 * 366 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;

/** A date at local midnight `dayOffset` days after `date` (DST-safe via components). */
function localDay(date: Date, dayOffset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, 0, 0, 0, 0);
}

/** Standard cron day rule: OR the two day fields when both are restricted. */
function dayMatches(fields: CronFields, date: Date): boolean {
  const dom = fields.dayOfMonth.has(date.getDate());
  const dow = fields.dayOfWeek.has(date.getDay());
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

/**
 * The first instant strictly after `from` that matches `fields`, in local time.
 * Throws `Error("no upcoming run")` when nothing matches within ~4 years.
 */
export function nextRunAt(fields: CronFields, from: Date): Date {
  if (Number.isNaN(from.getTime())) throw new Error("cannot schedule from an invalid Date");

  const minutes = [...fields.minute].sort((a, b) => a - b);
  const limit = from.getTime() + HORIZON_MS;

  // first candidate minute, strictly after `from` (floor on the epoch, so a
  // sub-minute `from` still lands on the next whole minute)
  let cursor = new Date(Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);

  while (cursor.getTime() <= limit) {
    const prev = cursor;
    let next: Date;

    if (!fields.month.has(prev.getMonth() + 1)) {
      // month: jump to the first minute of the next month
      next = new Date(prev.getFullYear(), prev.getMonth() + 1, 1, 0, 0, 0, 0);
    } else if (!dayMatches(fields, prev)) {
      // day: jump to the next local midnight
      next = localDay(prev, 1);
    } else if (!fields.hour.has(prev.getHours())) {
      // hour: jump to the top of the next hour
      next = new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate(),
        prev.getHours() + 1,
        0,
        0,
        0,
      );
    } else if (!fields.minute.has(prev.getMinutes())) {
      // minute: the next allowed minute in this hour, else the top of the next hour
      const nextMinute = minutes.find((m) => m > prev.getMinutes());
      next =
        nextMinute === undefined
          ? new Date(
              prev.getFullYear(),
              prev.getMonth(),
              prev.getDate(),
              prev.getHours() + 1,
              0,
              0,
              0,
            )
          : new Date(
              prev.getFullYear(),
              prev.getMonth(),
              prev.getDate(),
              prev.getHours(),
              nextMinute,
              0,
              0,
            );
    } else {
      return prev;
    }

    // Jumps are built from wall-clock components, so across a DST transition they can
    // land on or before `prev`; fall back to one real minute so the walk is strictly
    // increasing (and therefore always terminates).
    cursor =
      next.getTime() > prev.getTime()
        ? next
        : new Date(Math.floor(prev.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  }

  throw new Error("no upcoming run");
}

/** True when `parseCron` accepts `expr`. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}
