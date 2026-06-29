import {
  type CronIntervalUnit,
  createCronMessage,
  createScheduledMessage,
  formatCronInterval,
  formatScheduledAt,
  ScheduleValidationError,
} from "../schedules.ts";
import type { FunctionToolRunner, LlmToolContext } from "./types.ts";

export const scheduleMessageToolDefinition = {
  type: "function",
  name: "schedule_message",
  description:
    "Schedule a message to be sent in the current Telegram chat at a given ISO date and time, precise to minutes. The current chat and forum topic are used automatically. There can be up to 5 active scheduled messages per chat, and only 1 active scheduled message at the same date and minute per chat.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The exact Telegram message text to send later.",
      },
      at: {
        type: "string",
        description:
          "ISO 8601 date string for when to send the message. Include a timezone when possible. Seconds are ignored.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  strict: false,
} as const;

export const cronMessageToolDefinition = {
  type: "function",
  name: "cron_message",
  description:
    "Schedule a repeating message in the current Telegram chat. Set exactly one every_* parameter to a positive integer interval and leave the others null or omitted. The current chat and forum topic are used automatically. There can be up to 10 active cron messages per chat, and only 1 active cron message for the same interval per chat.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The exact Telegram message text to send repeatedly.",
      },
      every_dayOfWeek: {
        type: ["number", "null"],
        description:
          "Repeat on every Nth day-of-week cron step at 00:00 UTC. Use null unless this is the single chosen interval.",
        minimum: 1,
        maximum: 6,
      },
      every_month: {
        type: ["number", "null"],
        description:
          "Repeat every N months on day 1 at 00:00 UTC. Use null unless this is the single chosen interval.",
        minimum: 1,
        maximum: 12,
      },
      every_dayOfMonth: {
        type: ["number", "null"],
        description:
          "Repeat every N days of month at 00:00 UTC. Use null unless this is the single chosen interval.",
        minimum: 1,
        maximum: 31,
      },
      every_hour: {
        type: ["number", "null"],
        description:
          "Repeat every N hours at minute 0. Use null unless this is the single chosen interval.",
        minimum: 1,
        maximum: 23,
      },
      every_minute: {
        type: ["number", "null"],
        description:
          "Repeat every N minutes. Use null unless this is the single chosen interval.",
        minimum: 1,
        maximum: 59,
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  strict: false,
} as const;

function getMissingContextResponse(tool: string, context?: LlmToolContext) {
  return context
    ? undefined
    : `Cannot ${tool}: current chat context is unavailable.`;
}

function getMissingDatabaseResponse(tool: string, database: unknown) {
  return database ? undefined : `Cannot ${tool}: database is unavailable.`;
}

function parseMessage(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseRequiredDate(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseNullableNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getCronInterval(
  args: Record<string, unknown> | null,
): { intervalUnit: CronIntervalUnit; intervalValue: number } | string {
  const intervals = [
    {
      key: "every_dayOfWeek",
      intervalUnit: "dayOfWeek",
      intervalValue: parseNullableNumber(args?.every_dayOfWeek),
    },
    {
      key: "every_month",
      intervalUnit: "month",
      intervalValue: parseNullableNumber(args?.every_month),
    },
    {
      key: "every_dayOfMonth",
      intervalUnit: "dayOfMonth",
      intervalValue: parseNullableNumber(args?.every_dayOfMonth),
    },
    {
      key: "every_hour",
      intervalUnit: "hour",
      intervalValue: parseNullableNumber(args?.every_hour),
    },
    {
      key: "every_minute",
      intervalUnit: "minute",
      intervalValue: parseNullableNumber(args?.every_minute),
    },
  ] as const;
  const selected = intervals.filter(
    (interval) => interval.intervalValue !== undefined,
  );

  if (selected.length !== 1) {
    return "Cannot schedule cron message: set exactly one every_* interval.";
  }

  const interval = selected[0];
  if (interval.intervalValue === undefined) {
    return "Cannot schedule cron message: set exactly one every_* interval.";
  }

  return {
    intervalUnit: interval.intervalUnit,
    intervalValue: interval.intervalValue,
  };
}

function formatScheduleError(error: unknown, action: string): string {
  if (error instanceof ScheduleValidationError) {
    return `Cannot ${action}: ${error.message}`;
  }

  const details = error instanceof Error ? error.message : String(error);
  return `Cannot ${action}: ${details}`;
}

export const executeScheduleMessage: FunctionToolRunner = async (
  args,
  context,
  options,
) => {
  const missingContext = getMissingContextResponse("schedule message", context);
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const missingDatabase = getMissingDatabaseResponse(
    "schedule message",
    options?.database,
  );
  if (missingDatabase || !options?.database) {
    return missingDatabase ?? "";
  }

  try {
    const scheduledMessage = await createScheduledMessage(options.database, {
      chatId: context.chatId,
      threadId: context.threadId,
      message: parseMessage(args?.message),
      at: parseRequiredDate(args?.at),
    });

    return `Scheduled message ${scheduledMessage.id} for ${formatScheduledAt(
      scheduledMessage.scheduled_at,
    )}.`;
  } catch (error) {
    return formatScheduleError(error, "schedule message");
  }
};

export const executeCronMessage: FunctionToolRunner = async (
  args,
  context,
  options,
) => {
  const missingContext = getMissingContextResponse(
    "schedule cron message",
    context,
  );
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const missingDatabase = getMissingDatabaseResponse(
    "schedule cron message",
    options?.database,
  );
  if (missingDatabase || !options?.database) {
    return missingDatabase ?? "";
  }

  const interval = getCronInterval(args);
  if (typeof interval === "string") {
    return interval;
  }

  try {
    const cronMessage = await createCronMessage(options.database, {
      chatId: context.chatId,
      threadId: context.threadId,
      message: parseMessage(args?.message),
      intervalUnit: interval.intervalUnit,
      intervalValue: interval.intervalValue,
    });

    return `Scheduled cron message ${cronMessage.id}: ${formatCronInterval(
      cronMessage,
    )}.`;
  } catch (error) {
    return formatScheduleError(error, "schedule cron message");
  }
};
