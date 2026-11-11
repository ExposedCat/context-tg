import { test } from "bun:test";
import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
  throws,
} from "node:assert";
import {
  calculateOccurrences,
  describeRecurrence,
  MIN_RECURRENCE_MS,
  nextOccurrences,
  normalizeRecurrence,
  parseRecurrence,
  type Recurrence,
} from "./recurrence.ts";

const schedule = (
  rrule: string,
  timezone = "UTC",
  startsAt = "2026-11-12 09:00",
): Recurrence => ({ rrule, timezone, startsAt });
const dates = (input: Recurrence, after: string, count = 3) =>
  calculateOccurrences(input, Date.parse(after), count).map((date) =>
    new Date(date).toISOString(),
  );

test("RRULE intervals keep their phase across midnight and elapsed UTC intervals cross DST", () => {
  deepStrictEqual(
    dates(
      schedule("FREQ=HOURLY;INTERVAL=5", "UTC", "2026-10-24 20:00"),
      "2026-10-24T19:00:00Z",
      4,
    ),
    [
      "2026-10-24T20:00:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T06:00:00.000Z",
      "2026-10-25T11:00:00.000Z",
    ],
  );
  const rule = schedule("FREQ=MINUTELY;INTERVAL=7", "UTC", "2020-01-01 09:03");
  for (const occurrence of calculateOccurrences(
    rule,
    Date.parse("2026-11-11T00:00:00Z"),
    3,
  )) {
    strictEqual(
      (occurrence - Date.parse("2020-01-01T09:03:00Z")) % (7 * 60000),
      0,
    );
  }
});

test("daily wall time follows Prague DST independently of the host timezone", () => {
  const previous = process.env.TZ;
  try {
    for (const host of ["UTC", "Europe/Prague", "America/New_York"]) {
      process.env.TZ = host;
      deepStrictEqual(
        dates(
          schedule("FREQ=DAILY", "Europe/Prague", "2027-03-27 09:00"),
          "2027-03-27T00:00:00Z",
        ),
        [
          "2027-03-27T08:00:00.000Z",
          "2027-03-28T07:00:00.000Z",
          "2027-03-29T07:00:00.000Z",
        ],
      );
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("nonexistent local times are skipped and repeated local times fire once", () => {
  deepStrictEqual(
    dates(
      schedule("FREQ=DAILY", "Europe/Prague", "2027-03-27 02:30"),
      "2027-03-27T02:00:00Z",
      2,
    ),
    ["2027-03-29T00:30:00.000Z", "2027-03-30T00:30:00.000Z"],
  );
  deepStrictEqual(
    dates(
      schedule("FREQ=DAILY", "Europe/Prague", "2026-10-24 02:30"),
      "2026-10-25T00:31:00Z",
      2,
    ),
    ["2026-10-26T01:30:00.000Z", "2026-10-27T01:30:00.000Z"],
  );
});

test("COUNT, UTC UNTIL, and ordinal weekdays bound the actual occurrences", () => {
  deepStrictEqual(
    dates(
      schedule("FREQ=DAILY;COUNT=2", "Europe/Prague"),
      "2026-11-11T00:00:00Z",
      4,
    ),
    ["2026-11-12T08:00:00.000Z", "2026-11-13T08:00:00.000Z"],
  );
  deepStrictEqual(
    dates(
      schedule("FREQ=DAILY;UNTIL=20261113T080000Z", "Europe/Prague"),
      "2026-11-11T00:00:00Z",
      4,
    ),
    ["2026-11-12T08:00:00.000Z", "2026-11-13T08:00:00.000Z"],
  );
  deepStrictEqual(
    dates(schedule("FREQ=MONTHLY;BYDAY=1MO"), "2026-11-11T00:00:00Z", 2),
    ["2026-12-07T09:00:00.000Z", "2027-01-04T09:00:00.000Z"],
  );
});

test("five-minute validation checks expansions, wraparound and rare future dates", () => {
  for (const rrule of [
    "FREQ=MINUTELY",
    "FREQ=MINUTELY;INTERVAL=4",
    "FREQ=SECONDLY;INTERVAL=300",
    "FREQ=DAILY;BYMINUTE=0,1",
    "FREQ=HOURLY;BYMINUTE=0,59",
    "FREQ=DAILY;BYHOUR=0,23;BYMINUTE=0,59",
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYMINUTE=0,1",
    "FREQ=MONTHLY;BYMINUTE=0,1;BYSETPOS=1",
    "FREQ=DAILY;BYSECOND=0,30",
  ])
    throws(
      () => parseRecurrence(schedule(rrule)),
      /5 minutes|minute precision|minimum reminder spacing/,
    );
  for (const rrule of [
    "FREQ=MINUTELY;INTERVAL=5",
    "FREQ=MINUTELY;BYMINUTE=0,5,10",
    "FREQ=HOURLY;BYMINUTE=0,55",
    "FREQ=DAILY;BYHOUR=0,23;BYMINUTE=0,55",
  ]) {
    const input = schedule(rrule);
    parseRecurrence(input);
    const occurrences = calculateOccurrences(
      input,
      Date.parse("2026-11-11T00:00:00Z"),
      10,
    );
    for (let i = 1; i < occurrences.length; i++)
      strictEqual(
        occurrences[i] - occurrences[i - 1] >= MIN_RECURRENCE_MS,
        true,
      );
  }
});

test("strict parsing rejects injections, invalid ranges, ambiguous dates and invalid timezones", () => {
  for (const rrule of [
    "FREQ=DAILY\nRRULE:FREQ=MINUTELY",
    "FREQ=DAILY;FREQ=HOURLY",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY;INTERVAL=1.5",
    "FREQ=DAILY;BYHOUR=24",
    "FREQ=DAILY;BYMINUTE=-1",
    "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=DAILY;COUNT=1,2",
    "FREQ=DAILY;COUNT=2;UNTIL=20270101T000000Z",
    "FREQ=DAILY;BYDAY=NO",
    "FREQ=WEEKLY;BYDAY=1MO",
    "FREQ=DAILY;UNTIL=20270230T000000Z",
    "FREQ=DAILY;DTSTART=20200101T000000Z",
    "FREQ=DAILY;UNTIL=20270101",
    "BYHOUR=9",
  ])
    throws(() => parseRecurrence(schedule(rrule)));
  throws(() => parseRecurrence(schedule("FREQ=DAILY", "No/SuchZone")));
  throws(() =>
    parseRecurrence(schedule("FREQ=DAILY", "UTC", "2026-02-30 09:00")),
  );
  throws(() =>
    parseRecurrence(schedule("FREQ=DAILY", "UTC", "2026-11-12T09:00:00Z")),
  );
  throws(
    () =>
      parseRecurrence(
        schedule("FREQ=DAILY", "Europe/Prague", "2027-03-28 02:30"),
      ),
    /does not exist/,
  );
});

test("rrule NLP descriptions include exact times, anchors and otherwise omitted selectors", () => {
  strictEqual(
    describeRecurrence(schedule("FREQ=DAILY", "Europe/Prague")),
    "Every day at 09:00 (Europe/Prague)",
  );
  strictEqual(
    describeRecurrence(schedule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")),
    "Every weekday at 09:00 (UTC)",
  );
  strictEqual(
    describeRecurrence(schedule("FREQ=MONTHLY;BYDAY=1MO")),
    "Every month on the 1st Monday at 09:00 (UTC)",
  );
  strictEqual(
    describeRecurrence(
      schedule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"),
    ),
    "Every month on the last weekday at 09:00 (UTC)",
  );
  match(describeRecurrence(schedule("FREQ=WEEKLY")), /Thursday/);
  match(describeRecurrence(schedule("FREQ=MONTHLY")), /12th/);
  match(
    describeRecurrence(schedule("FREQ=HOURLY;INTERVAL=5")),
    /Every 5 hours at minute 00/,
  );
  strictEqual(
    describeRecurrence(
      normalizeRecurrence(schedule("FREQ=MINUTELY;INTERVAL=5")),
    ),
    "Every 5 minutes (UTC)",
  );
});

test("pathological rules run in a terminable worker instead of blocking the bot", async () => {
  deepStrictEqual(
    (
      await nextOccurrences(
        schedule("FREQ=DAILY"),
        Date.parse("2026-11-11T00:00:00Z"),
        1,
      )
    ).map((date) => new Date(date).toISOString()),
    ["2026-11-12T09:00:00.000Z"],
  );
  await rejects(
    nextOccurrences(
      schedule("FREQ=MINUTELY;INTERVAL=5;BYMONTH=2;BYMONTHDAY=30"),
      Date.parse("2026-11-11T00:00:00Z"),
      1,
      50,
    ),
    /timed out/,
  );
});
