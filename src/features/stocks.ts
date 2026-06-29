export type MarketSessionState =
  | "after-hours (morning)"
  | "overnight"
  | "premarket"
  | "open"
  | "postmarket"
  | "after-hours (night)";

export type ResponseTimeZone = "Europe/Prague" | "Europe/Kyiv";

export type ExchangeMarketState = {
  exchange: "UK" | "US";
  name: string;
  timeZone: string;
  currentExchangeTime: ExchangeLocalTime;
  isRegularTradingDay: boolean;
  currentState: MarketSessionState;
  nextState: MarketSessionState;
  timeUntilNextState: MarketStateCountdown;
  nextStateAt: MarketTime[];
  schedule: LocalizedMarketSession[];
};

export type MarketsState = {
  generatedAt: string;
  currentTimes: MarketTime[];
  exchanges: ExchangeMarketState[];
  notes: string[];
};

export type MarketTime = {
  timeZone: ResponseTimeZone;
  localDate: string;
  localTime: string;
  weekday: string;
};

export type ExchangeLocalTime = {
  timeZone: string;
  localDate: string;
  localTime: string;
  weekday: string;
};

export type MarketSession = {
  state: MarketSessionState;
  start: string;
  end: string;
};

export type LocalizedMarketSessionTime = {
  timeZone: ResponseTimeZone;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
};

export type LocalizedMarketSession = MarketSession & {
  timeZones: LocalizedMarketSessionTime[];
};

export type MarketStateCountdown = {
  totalMinutes: number;
  hours: number;
  minutes: number;
  human: string;
};

type MarketSessionOccurrence = MarketSession & {
  startAt: Date;
  endAt: Date;
};

type TemporalApi = {
  ZonedDateTime: {
    from(options: {
      timeZone: string;
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
    }): { epochMilliseconds: number };
  };
};

type MarketStateTransition = {
  state: MarketSessionState;
  nextState: MarketSessionState;
  transitionAt: Date;
};

type MarketDefinition = {
  exchange: ExchangeMarketState["exchange"];
  name: string;
  timeZone: string;
  weekdaySchedule: MarketSession[];
  weekendSchedule: MarketSession[];
};

type LocalDateTime = {
  date: string;
  time: string;
  weekday: string;
  weekdayIndex: number;
  minutes: number;
};

const RESPONSE_TIME_ZONES: ResponseTimeZone[] = [
  "Europe/Prague",
  "Europe/Kyiv",
];

const MARKET_DEFINITIONS: MarketDefinition[] = [
  {
    exchange: "UK",
    name: "London Stock Exchange",
    timeZone: "Europe/London",
    weekdaySchedule: [
      { state: "overnight", start: "00:00", end: "02:00" },
      { state: "after-hours (morning)", start: "02:00", end: "07:00" },
      { state: "premarket", start: "07:00", end: "08:00" },
      { state: "open", start: "08:00", end: "16:30" },
      { state: "postmarket", start: "16:30", end: "17:15" },
      { state: "after-hours (night)", start: "17:15", end: "24:00" },
    ],
    weekendSchedule: [
      { state: "overnight", start: "00:00", end: "02:00" },
      { state: "after-hours (morning)", start: "02:00", end: "12:00" },
      { state: "after-hours (night)", start: "12:00", end: "24:00" },
    ],
  },
  {
    exchange: "US",
    name: "NYSE/Nasdaq",
    timeZone: "America/New_York",
    weekdaySchedule: [
      { state: "overnight", start: "00:00", end: "02:00" },
      { state: "after-hours (morning)", start: "02:00", end: "04:00" },
      { state: "premarket", start: "04:00", end: "09:30" },
      { state: "open", start: "09:30", end: "16:00" },
      { state: "postmarket", start: "16:00", end: "20:00" },
      { state: "after-hours (night)", start: "20:00", end: "21:00" },
      { state: "overnight", start: "21:00", end: "24:00" },
    ],
    weekendSchedule: [
      { state: "overnight", start: "00:00", end: "02:00" },
      { state: "after-hours (morning)", start: "02:00", end: "12:00" },
      { state: "after-hours (night)", start: "12:00", end: "24:00" },
    ],
  },
];

function getPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function parseClock(clock: string): number {
  if (clock === "24:00") {
    return 24 * 60;
  }

  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

function parseLocalDate(date: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = date.split("-").map(Number);

  return { year, month, day };
}

function addDaysToLocalDate(date: string, days: number): string {
  const { year, month, day } = parseLocalDate(date);
  const result = new Date(Date.UTC(year, month - 1, day + days));

  return [
    result.getUTCFullYear(),
    String(result.getUTCMonth() + 1).padStart(2, "0"),
    String(result.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function getLocalDateTime(date: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const weekday = getPart(parts, "weekday");
  const hour = Number(getPart(parts, "hour"));
  const minute = Number(getPart(parts, "minute"));

  return {
    date: `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(
      parts,
      "day",
    )}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekday,
    weekdayIndex: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      weekday,
    ),
    minutes: hour * 60 + minute,
  };
}

function localDateTimeToDate(
  localDate: string,
  clock: string,
  timeZone: string,
): Date {
  const minutes = parseClock(clock);
  const date =
    minutes >= 24 * 60 ? addDaysToLocalDate(localDate, 1) : localDate;
  const { year, month, day } = parseLocalDate(date);
  const hour = Math.floor((minutes % (24 * 60)) / 60);
  const minute = minutes % 60;
  const temporal = (globalThis as unknown as { Temporal: TemporalApi })
    .Temporal;
  const zonedDateTime = temporal.ZonedDateTime.from({
    timeZone,
    year,
    month,
    day,
    hour,
    minute,
  });

  return new Date(zonedDateTime.epochMilliseconds);
}

function getMarketTime(date: Date, timeZone: ResponseTimeZone): MarketTime {
  const local = getLocalDateTime(date, timeZone);

  return {
    timeZone,
    localDate: local.date,
    localTime: local.time,
    weekday: local.weekday,
  };
}

function getScheduleForWeekdayIndex(
  market: MarketDefinition,
  weekdayIndex: number,
): MarketSession[] {
  return weekdayIndex >= 1 && weekdayIndex <= 5
    ? market.weekdaySchedule
    : market.weekendSchedule;
}

function getScheduleForLocalDate(
  market: MarketDefinition,
  localDate: string,
): MarketSession[] {
  const noon = localDateTimeToDate(localDate, "12:00", market.timeZone);
  const local = getLocalDateTime(noon, market.timeZone);

  return getScheduleForWeekdayIndex(market, local.weekdayIndex);
}

function getSessionOccurrence(
  session: MarketSession,
  localDate: string,
  timeZone: string,
): MarketSessionOccurrence {
  const endMinutes = parseClock(session.end);
  const startMinutes = parseClock(session.start);
  const endDate =
    endMinutes < 24 * 60 && endMinutes <= startMinutes
      ? addDaysToLocalDate(localDate, 1)
      : localDate;

  return {
    ...session,
    startAt: localDateTimeToDate(localDate, session.start, timeZone),
    endAt: localDateTimeToDate(endDate, session.end, timeZone),
  };
}

function getSessionOccurrences(
  market: MarketDefinition,
  anchorLocalDate: string,
): MarketSessionOccurrence[] {
  return [-1, 0, 1, 2, 3]
    .flatMap((dayOffset) => {
      const localDate = addDaysToLocalDate(anchorLocalDate, dayOffset);
      return getScheduleForLocalDate(market, localDate).map((session) =>
        getSessionOccurrence(session, localDate, market.timeZone),
      );
    })
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
}

function getMarketStateTransition(
  market: MarketDefinition,
  date: Date,
  anchorLocalDate: string,
): MarketStateTransition {
  const occurrences = getSessionOccurrences(market, anchorLocalDate);
  const currentIndex = occurrences.findIndex(
    (occurrence) => date >= occurrence.startAt && date < occurrence.endAt,
  );

  if (currentIndex === -1) {
    throw new Error(
      `Could not resolve current market session for ${market.name}`,
    );
  }

  const current = occurrences[currentIndex];
  const next = occurrences[currentIndex + 1];

  if (!next) {
    throw new Error(`Could not resolve next market session for ${market.name}`);
  }

  return {
    state: current.state,
    nextState: next.state,
    transitionAt: current.endAt,
  };
}

function getCountdown(from: Date, to: Date): MarketStateCountdown {
  const totalMinutes = Math.max(
    0,
    Math.ceil((to.getTime() - from.getTime()) / 60_000),
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return {
    totalMinutes,
    hours,
    minutes,
    human: `${hours}h ${minutes}m`,
  };
}

function getLocalizedSessionTime(
  session: MarketSession,
  localDate: string,
  exchangeTimeZone: string,
  responseTimeZone: ResponseTimeZone,
): LocalizedMarketSessionTime {
  const occurrence = getSessionOccurrence(session, localDate, exchangeTimeZone);
  const start = getLocalDateTime(occurrence.startAt, responseTimeZone);
  const end = getLocalDateTime(occurrence.endAt, responseTimeZone);

  return {
    timeZone: responseTimeZone,
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
  };
}

function getLocalizedMarketSchedule(
  market: MarketDefinition,
  localDate: string,
): LocalizedMarketSession[] {
  return market.weekdaySchedule.map((session) => ({
    ...session,
    timeZones: RESPONSE_TIME_ZONES.map((timeZone) =>
      getLocalizedSessionTime(session, localDate, market.timeZone, timeZone),
    ),
  }));
}

function getExchangeMarketState(
  market: MarketDefinition,
  date: Date,
): ExchangeMarketState {
  const local = getLocalDateTime(date, market.timeZone);
  const isRegularTradingDay =
    local.weekdayIndex >= 1 && local.weekdayIndex <= 5;
  const transition = getMarketStateTransition(market, date, local.date);

  return {
    exchange: market.exchange,
    name: market.name,
    timeZone: market.timeZone,
    currentExchangeTime: {
      timeZone: market.timeZone,
      localDate: local.date,
      localTime: local.time,
      weekday: local.weekday,
    },
    isRegularTradingDay,
    currentState: transition.state,
    nextState: transition.nextState,
    timeUntilNextState: getCountdown(date, transition.transitionAt),
    nextStateAt: RESPONSE_TIME_ZONES.map((timeZone) =>
      getMarketTime(transition.transitionAt, timeZone),
    ),
    schedule: getLocalizedMarketSchedule(market, local.date),
  };
}

export function getMarketsState(date = new Date()): MarketsState {
  return {
    generatedAt: date.toISOString(),
    currentTimes: RESPONSE_TIME_ZONES.map((timeZone) =>
      getMarketTime(date, timeZone),
    ),
    exchanges: MARKET_DEFINITIONS.map((market) =>
      getExchangeMarketState(market, date),
    ),
    notes: [
      "Times are interpreted in each exchange's local timezone.",
      "Each exchange schedule is the regular weekday schedule localized to Europe/Prague and Europe/Kyiv.",
      "Schedules do not account for exchange holidays or half-days.",
    ],
  };
}
