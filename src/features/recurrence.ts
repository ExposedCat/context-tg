import { Temporal } from "@js-temporal/polyfill";
import { RRule } from "rrule";

export const MIN_RECURRENCE_MS = 5 * 60_000;
export type Recurrence = {
  rrule: string;
  startsAt: string;
  timezone: string;
};

export class RecurrenceValidationError extends Error {}

function invalid(message: string): never {
  throw new RecurrenceValidationError(message);
}

function floatingDate(value: Temporal.PlainDateTime): Date {
  return new Date(`${value.toString({ smallestUnit: "second" })}Z`);
}

function localDate(value: Date): Temporal.PlainDateTime {
  return Temporal.PlainDateTime.from(value.toISOString().slice(0, -1));
}

function asList(value: number | number[] | null | undefined): number[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function checkSpacing(values: number[], period: number): void {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1] ?? sorted[0] + period;
    if (next - sorted[i] < 5) {
      invalid(
        "Recurring reminders must be at least 5 minutes apart, including across hour/day boundaries.",
      );
    }
  }
}

/** Prove a conservative lower bound, rather than sampling a finite preview.
 * Date filters and BYSETPOS can only remove candidates from these time sets.
 * Time-zone transitions are additionally protected by the persisted send gate.
 */
function validateSpacing(rule: RRule): void {
  const options = rule.options;
  if (options.freq === RRule.SECONDLY) {
    invalid(
      "SECONDLY recurrence is unsupported. Use MINUTELY with INTERVAL=5 or greater.",
    );
  }
  if (options.freq === RRule.MINUTELY && options.interval >= 5) return;
  if (options.freq <= RRule.DAILY) {
    checkSpacing(
      options.byhour.flatMap((hour) =>
        options.byminute.map((minute) => hour * 60 + minute),
      ),
      1440,
    );
  } else {
    const minutes = options.byminute;
    if (!minutes?.length)
      invalid(
        "MINUTELY recurrence needs INTERVAL>=5 or a BYMINUTE list spaced at least 5 minutes apart.",
      );
    checkSpacing(minutes, 60);
  }
}

/** Strictly validate tokens before passing them to rrule's permissive parser. */
export function parseRecurrence(input: Recurrence): RRule {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(input.timezone)) {
    invalid("Use an IANA timezone such as Europe/Prague or UTC.");
  }
  let start: Temporal.PlainDateTime;
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(input.startsAt))
      throw new Error();
    start = Temporal.PlainDateTime.from(input.startsAt.replace(" ", "T"));
    if (start.year < 1970 || start.year > 9998)
      invalid("Start year must be between 1970 and 9998.");
    const zoned = start.toZonedDateTime(input.timezone, {
      disambiguation: "earlier",
    });
    if (!zoned.toPlainDateTime().equals(start))
      invalid("The start time does not exist in that timezone.");
  } catch (error) {
    if (error instanceof RecurrenceValidationError) throw error;
    invalid(
      "Invalid start date/time or timezone. Use YYYY-MM-DD HH:mm and an IANA timezone.",
    );
  }
  const source = input.rrule
    .trim()
    .replace(/^RRULE:/i, "")
    .toUpperCase();
  if (!source || source.length > 2000 || /\s/.test(source))
    invalid(
      "Supply one RRULE, without DTSTART, RDATE, EXDATE or embedded lines.",
    );
  const fields = new Map<string, string>();
  const ranges: Record<string, [number, number, boolean?]> = {
    INTERVAL: [1, 10000],
    COUNT: [1, 100000],
    BYMONTH: [1, 12],
    BYMONTHDAY: [-31, 31, true],
    BYYEARDAY: [-366, 366, true],
    BYWEEKNO: [-53, 53, true],
    BYSETPOS: [-366, 366, true],
    BYHOUR: [0, 23],
    BYMINUTE: [0, 59],
    BYSECOND: [0, 0],
  };
  for (const token of source.split(";")) {
    const match = /^([A-Z]+)=([^=]+)$/.exec(token);
    if (!match || fields.has(match[1]))
      invalid("Invalid or duplicate RRULE property.");
    const [, key, value] = match;
    fields.set(key, value);
    if (key === "FREQ") {
      if (!/^(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY)$/.test(value))
        invalid(
          "Unsupported frequency. The minimum reminder spacing is 5 minutes.",
        );
    } else if (key === "WKST") {
      if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(value))
        invalid("Invalid week start.");
    } else if (key === "BYDAY") {
      for (const day of value.split(",")) {
        if (
          !/^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(day) ||
          Math.abs(Number(day.slice(0, -2))) > 53
        )
          invalid("Invalid BYDAY value.");
      }
    } else if (key === "UNTIL") {
      if (!/^\d{8}T\d{6}Z$/.test(value))
        invalid("UNTIL must be a UTC date/time, for example 20271231T225900Z.");
      try {
        Temporal.Instant.from(
          value.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
            "$1-$2-$3T$4:$5:$6Z",
          ),
        );
      } catch {
        invalid("Invalid UNTIL date.");
      }
    } else {
      const range = ranges[key];
      if (!range) invalid(`Unsupported RRULE property: ${key}.`);
      const values = value.split(",");
      if ((key === "COUNT" || key === "INTERVAL") && values.length !== 1)
        invalid(`Invalid ${key}.`);
      if (values.length > 366) invalid("Too many RRULE values.");
      for (const item of values) {
        const number = Number(item);
        if (
          !/^[+-]?\d+$/.test(item) ||
          !Number.isSafeInteger(number) ||
          number < range[0] ||
          number > range[1] ||
          (range[2] && number === 0)
        ) {
          invalid(
            key === "BYSECOND"
              ? "Reminders have minute precision; BYSECOND must be 0."
              : `Invalid ${key} value.`,
          );
        }
      }
    }
  }
  if (!fields.has("FREQ")) invalid("RRULE must specify FREQ.");
  if (fields.has("COUNT") && fields.has("UNTIL"))
    invalid("Use COUNT or UNTIL, not both.");
  const frequency = fields.get("FREQ");
  if (fields.has("BYWEEKNO") && frequency !== "YEARLY")
    invalid("BYWEEKNO requires YEARLY recurrence.");
  if (
    fields.has("BYYEARDAY") &&
    ["DAILY", "WEEKLY", "MONTHLY"].includes(frequency ?? "")
  )
    invalid(
      "BYYEARDAY cannot be combined with DAILY, WEEKLY or MONTHLY recurrence.",
    );
  if (fields.has("BYMONTHDAY") && frequency === "WEEKLY")
    invalid("BYMONTHDAY cannot be combined with WEEKLY recurrence.");
  if (
    fields.has("BYSETPOS") &&
    ![...fields.keys()].some(
      (key) => key.startsWith("BY") && key !== "BYSETPOS",
    )
  )
    invalid("BYSETPOS requires another BY selector.");
  if (
    fields.has("BYDAY") &&
    /\d/.test(fields.get("BYDAY") ?? "") &&
    !["MONTHLY", "YEARLY"].includes(fields.get("FREQ") ?? "")
  )
    invalid("Ordinal weekdays require MONTHLY or YEARLY recurrence.");
  let rule: RRule;
  try {
    rule = new RRule(
      {
        ...RRule.parseString(source),
        dtstart: floatingDate(start),
        bysecond: 0,
      },
      true,
    );
  } catch {
    invalid("Invalid RRULE.");
  }
  validateSpacing(rule);
  return rule;
}

export function normalizeRecurrence(input: Recurrence): Recurrence {
  const rule = parseRecurrence(input);
  return {
    rrule: RRule.optionsToString({
      ...rule.origOptions,
      dtstart: undefined,
    }).replace(/^RRULE:/, ""),
    startsAt: input.startsAt.replace("T", " "),
    timezone: new Intl.DateTimeFormat("en", {
      timeZone: input.timezone,
    }).resolvedOptions().timeZone,
  };
}

/** Runs only in a bounded worker; pathological date filters must not block the bot. */
export function calculateOccurrences(
  input: Recurrence,
  after: number,
  count: number,
): number[] {
  const original = parseRecurrence(input);
  const zone = input.timezone;
  const afterLocal = Temporal.Instant.fromEpochMilliseconds(after)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime();
  // Start a day back to include candidates near DST folds. Already-delivered
  // wall times map to their earlier instant and are excluded by the UTC check.
  let cursor = floatingDate(afterLocal.subtract({ days: 1 }));
  const options = { ...original.origOptions };
  const until = options.until?.getTime();
  if (options.until) {
    options.until = floatingDate(
      Temporal.Instant.fromEpochMilliseconds(options.until.getTime())
        .toZonedDateTimeISO(zone)
        .toPlainDateTime(),
    );
  }
  // Fast-forward dense, unbounded rules without changing their phase.
  if (!options.count && original.options.freq >= RRule.HOURLY) {
    const step =
      original.options.interval *
      (original.options.freq === RRule.HOURLY ? 3600000 : 60000);
    const start = original.options.dtstart.getTime();
    const periods = Math.max(
      0,
      Math.floor((cursor.getTime() - start) / step) - 1,
    );
    options.dtstart = new Date(start + periods * step);
    options.byminute = original.options.byminute;
  }
  const rule = new RRule(options, true);
  const result: number[] = [];
  while (result.length < count) {
    const next = rule.after(cursor);
    if (!next) break;
    cursor = next;
    const local = localDate(next);
    const zoned = local.toZonedDateTime(zone, { disambiguation: "earlier" });
    if (!zoned.toPlainDateTime().equals(local)) continue; // nonexistent DST time
    const instant = zoned.epochMilliseconds;
    if (until !== undefined && instant > until) break;
    if (instant > after) result.push(instant);
  }
  return result;
}

export function nextOccurrences(
  input: Recurrence,
  after = Date.now(),
  count = 3,
  timeoutMs = 2000,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./recurrence-worker.ts", import.meta.url).href,
    );
    const finish = (error?: Error, dates?: number[]) => {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error);
      else resolve(dates ?? []);
    };
    const timeout = setTimeout(
      () =>
        finish(
          new RecurrenceValidationError(
            "Recurrence calculation timed out. Simplify the rule or use a more recent start date.",
          ),
        ),
      timeoutMs,
    );
    worker.onmessage = (
      event: MessageEvent<{ dates?: number[]; error?: string }>,
    ) => {
      finish(
        event.data.error
          ? new RecurrenceValidationError(event.data.error)
          : undefined,
        event.data.dates,
      );
    };
    worker.onerror = (event) =>
      finish(new RecurrenceValidationError(event.message));
    worker.postMessage({ input, after, count });
  });
}

export function describeRecurrence(input: Recurrence): string {
  const rule = parseRecurrence(input);
  // rrule's NLP omits minutes and some advanced selectors. Use it for the
  // calendar phrase, then explicitly describe the remaining constraints.
  const {
    byhour: _h,
    byminute: _m,
    bysecond: _s,
    bysetpos,
    until,
    ...base
  } = rule.origOptions;
  // Use the effective defaults (DTSTART anchors missing calendar selectors).
  if (rule.options.freq === RRule.WEEKLY && !rule.origOptions.byweekday)
    base.byweekday = [
      Temporal.PlainDateTime.from(input.startsAt.replace(" ", "T")).dayOfWeek -
        1,
    ];
  if (
    rule.options.freq === RRule.MONTHLY &&
    !base.bymonthday &&
    !base.byweekday
  )
    base.bymonthday = rule.options.bymonthday;
  if (
    rule.options.freq === RRule.YEARLY &&
    !base.bymonth &&
    !base.byyearday &&
    !base.byweekno
  )
    base.bymonth = rule.options.bymonth;
  if (
    rule.options.freq === RRule.YEARLY &&
    !base.bymonthday &&
    !base.byweekday &&
    !base.byyearday &&
    !base.byweekno
  )
    base.bymonthday = rule.options.bymonthday;
  let text = new RRule(base, true).toText();
  const extras: string[] = [];
  if (rule.options.freq <= RRule.DAILY) {
    const times = rule.options.byhour.flatMap((hour) =>
      rule.options.byminute.map(
        (minute) =>
          `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ),
    );
    if (times.length <= 8) extras.push(`at ${times.join(", ")}`);
    else
      extras.push(
        `at minutes ${rule.options.byminute.map((minute) => String(minute).padStart(2, "0")).join(", ")} past hours ${rule.options.byhour.map((hour) => String(hour).padStart(2, "0")).join(", ")}`,
      );
  } else if (rule.options.freq === RRule.HOURLY) {
    extras.push(
      `at minute ${rule.options.byminute.map((minute) => String(minute).padStart(2, "0")).join(", ")}`,
    );
  } else if (rule.origOptions.byminute != null)
    extras.push(`at minute ${asList(rule.origOptions.byminute).join(", ")}`);
  if (rule.options.freq >= RRule.HOURLY) {
    if (rule.origOptions.byhour != null)
      extras.push(
        `during hours ${asList(rule.origOptions.byhour)
          .map((hour) => `${String(hour).padStart(2, "0")}:00`)
          .join(", ")}`,
      );
    const filters = {
      ...base,
      freq: RRule.DAILY,
      interval: 1,
      count: undefined,
      until: undefined,
    };
    const filterText = new RRule(filters, true)
      .toText()
      .replace(/^every day\s*/, "");
    if (filterText) extras.push(filterText);
  }
  if (bysetpos != null) {
    if (
      asList(bysetpos).length === 1 &&
      asList(bysetpos)[0] === -1 &&
      rule.options.freq === RRule.MONTHLY &&
      rule.options.byhour.length * rule.options.byminute.length === 1 &&
      /on weekdays/.test(text)
    ) {
      text = text.replace("on weekdays", "on the last weekday");
    } else
      extras.push(
        `matching positions ${asList(bysetpos)
          .map((n) => (n === -1 ? "last" : n))
          .join(", ")}`,
      );
  }
  if (base.wkst != null) extras.push(`week starts ${String(base.wkst)}`);
  if (until)
    extras.push(
      `until ${formatRecurrenceDate(until.getTime(), input.timezone)}`,
    );
  text = `${text[0].toUpperCase()}${text.slice(1)}${extras.length ? ` ${extras.join("; ")}` : ""} (${input.timezone})`;
  return text;
}

export function formatRecurrenceDate(
  instant: number,
  timezone: string,
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}
