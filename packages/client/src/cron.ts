// A display-only cron describer for the UI.
//
// This is presentation, not scheduling: the server owns the real cron engine and
// the canonical parse, and nothing here is ever sent back over the wire. So the
// check below is deliberately lenient — it only insists on five whitespace-separated
// fields and on the individual values a phrase would print being in range. Anything
// it does not recognise, or would not want to claim, falls back to `cron <expr>`
// rather than guessing at something more precise than it knows.

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const WEEKDAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/** A single literal value in `[min, max]`, or null when `text` is not one. */
function singleValue(text: string, min: number, max: number, names?: Record<string, number>) {
  const name = names?.[text.toUpperCase()];
  if (name !== undefined) return name;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/**
 * A short human phrase for the UI, e.g. "daily at 09:30".
 *
 * Only shapes it recognises are described; everything else falls back to
 * `cron <expr>` rather than guessing at something more precise than it knows.
 */
export function describeCron(expr: string): string {
  const generic = `cron ${expr}`;

  const texts = expr.trim().split(/\s+/);
  if (texts.length !== 5) return generic;
  const [mText, hText, domText, moText, dowText] = texts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const allStar = moText === "*" && domText === "*" && dowText === "*";

  // every N minutes
  const stepMatch = /^\*\/(\d+)$/.exec(mText);
  if (stepMatch && Number(stepMatch[1]) >= 1 && hText === "*" && allStar) {
    return `every ${stepMatch[1]} minutes`;
  }

  // every hour at :MM
  const minute = singleValue(mText, 0, 59);
  if (minute !== null && hText === "*" && allStar) {
    return `every hour at :${pad(minute)}`;
  }

  const hour = singleValue(hText, 0, 23);
  if (minute === null || hour === null) return generic;
  const at = `${pad(hour)}:${pad(minute)}`;

  // weekdays at HH:MM
  if (domText === "*" && moText === "*" && dowText === "1-5") {
    return `weekdays at ${at}`;
  }

  // every <Weekday> at HH:MM
  if (domText === "*" && moText === "*") {
    const dow = singleValue(dowText, 0, 7, WEEKDAY_NAMES);
    if (dow !== null) {
      const label = WEEKDAY_LABELS[dow === 7 ? 0 : dow];
      if (label) return `every ${label} at ${at}`;
    }
  }

  // monthly on the Nth at HH:MM
  if (moText === "*" && dowText === "*") {
    const dom = singleValue(domText, 1, 31);
    if (dom !== null) return `monthly on the ${ordinal(dom)} at ${at}`;
  }

  // daily at HH:MM
  if (allStar) return `daily at ${at}`;

  return generic;
}
