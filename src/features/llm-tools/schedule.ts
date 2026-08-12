import type { Database } from "../database.ts";
import {
  type CronIntervalUnit,
  cancelCronMessageByNumber,
  cancelScheduledMessageByNumber,
  createCronMessage,
  createScheduledMessage,
  formatCronInterval,
  formatScheduledAt,
  getScheduleList,
  ScheduleValidationError,
} from "../schedules.ts";
import type { FunctionToolRunner } from "./types.ts";
import {
  getFiniteNumber,
  getJsonError,
  getMissingContextResponse,
  getMissingDatabaseResponse,
  getString,
} from "./utils.ts";

export const scheduleMessageToolDefinition = {
  type: "function",
  name: "schedule_message",
  description:
    "Schedule a message to be sent at a given local date and time, precise to minutes. Use YYYY-MM-DD HH:mm without a timezone suffix.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The exact message text to send later.",
      },
      short_elaboration: {
        type: "string",
        description:
          "Provide a 1-3 word concise elaboration of what this message is. Do not write the message itself here.",
      },
      at: {
        type: "string",
        description:
          "Local date/time in YYYY-MM-DD HH:mm format, for example 2022-12-01 10:05.",
      },
    },
    required: ["message", "short_elaboration"],
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
      short_elaboration: {
        type: "string",
        description:
          "Provide a 1-3 word concise elaboration of what this message is. Do not write the message itself here.",
      },
      every_dayOfWeek: {
        type: ["number", "null"],
        description:
          "Repeat every N weeks. Use null unless this is the single chosen interval.",
        minimum: 1,
        maximum: 6,
      },
      every_month: {
        type: ["number", "null"],
        description:
          "Repeat every N months. Use null unless this is the single chosen interval.",
        minimum: 1,
        maximum: 12,
      },
      every_dayOfMonth: {
        type: ["number", "null"],
        description:
          "Repeat every N days. Use null unless this is the single chosen interval.",
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
    required: ["message", "short_elaboration"],
    additionalProperties: false,
  },
  strict: false,
} as const;

export const getScheduledMessagesToolDefinition = {
  type: "function",
  name: "get_scheduled_messages",
  description:
    "Get the current chat's one-time and repeating scheduled messages. Returns the same schedule shown by /schedule, including the cancellation id for each message.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const cancelScheduledMessageToolDefinition = {
  type: "function",
  name: "cancel_scheduled_message",
  description:
    "Cancel a one-time or repeating scheduled message in the current chat, then return the updated schedule. Use the id shown after /cancel_ by get_scheduled_messages, for example s1 or c1.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "The cancellation id shown after /cancel_, for example s1 for a one-time message or c1 for a repeating message.",
        pattern: "^[sc][1-9][0-9]*$",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function getCronInterval(
  args: Record<string, unknown> | null,
): { intervalUnit: CronIntervalUnit; intervalValue: number } | string {
  const intervals = [
    {
      key: "every_dayOfWeek",
      intervalUnit: "dayOfWeek",
      intervalValue: getFiniteNumber(args?.every_dayOfWeek),
    },
    {
      key: "every_month",
      intervalUnit: "month",
      intervalValue: getFiniteNumber(args?.every_month),
    },
    {
      key: "every_dayOfMonth",
      intervalUnit: "dayOfMonth",
      intervalValue: getFiniteNumber(args?.every_dayOfMonth),
    },
    {
      key: "every_hour",
      intervalUnit: "hour",
      intervalValue: getFiniteNumber(args?.every_hour),
    },
    {
      key: "every_minute",
      intervalUnit: "minute",
      intervalValue: getFiniteNumber(args?.every_minute),
    },
  ] as const;
  const selected = intervals.filter(
    (interval) => interval.intervalValue !== undefined,
  );

  if (selected.length !== 1) {
    return getJsonError(
      "Cannot schedule cron message: set exactly one every_* interval.",
    );
  }

  const interval = selected[0];
  if (interval.intervalValue === undefined) {
    return getJsonError(
      "Cannot schedule cron message: set exactly one every_* interval.",
    );
  }

  return {
    intervalUnit: interval.intervalUnit,
    intervalValue: interval.intervalValue,
  };
}

function formatScheduleError(error: unknown, action: string): string {
  if (error instanceof ScheduleValidationError) {
    return getJsonError(`Cannot ${action}: ${error.message}`);
  }

  const details = error instanceof Error ? error.message : String(error);
  return getJsonError(`Cannot ${action}: ${details}`);
}

function getShortElaboration(args: Record<string, unknown> | null): string {
  return getString(args?.short_elaboration ?? args?.["short elaboration"]);
}

type ScheduleCancellationId = {
  kind: "cron" | "scheduled";
  number: number;
};

function parseScheduleCancellationId(
  value: unknown,
): ScheduleCancellationId | undefined {
  const match = getString(value).match(/^([sc])([1-9]\d*)$/);
  if (!match) {
    return undefined;
  }

  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) {
    return undefined;
  }

  return {
    kind: match[1] === "s" ? "scheduled" : "cron",
    number,
  };
}

async function getPlainSchedule(
  database: Database,
  chatId: number,
): Promise<string> {
  return await getScheduleList(database, chatId, false);
}

export const executeGetScheduledMessages: FunctionToolRunner = async (
  _args,
  context,
  options,
) => {
  const missingContext = getMissingContextResponse(
    "get scheduled messages",
    context,
  );
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const missingDatabase = getMissingDatabaseResponse(
    "get scheduled messages",
    options?.database,
  );
  if (missingDatabase || !options?.database) {
    return missingDatabase ?? "";
  }

  return await getPlainSchedule(options.database, context.chatId);
};

export const executeCancelScheduledMessage: FunctionToolRunner = async (
  args,
  context,
  options,
) => {
  const missingContext = getMissingContextResponse(
    "cancel scheduled message",
    context,
  );
  if (missingContext || !context) {
    return missingContext ?? "";
  }

  const missingDatabase = getMissingDatabaseResponse(
    "cancel scheduled message",
    options?.database,
  );
  if (missingDatabase || !options?.database) {
    return missingDatabase ?? "";
  }

  const cancellationId = parseScheduleCancellationId(args?.id);
  if (!cancellationId) {
    return getJsonError(
      "Cannot cancel scheduled message: id must look like s1 or c1.",
    );
  }

  const result =
    cancellationId.kind === "scheduled"
      ? await cancelScheduledMessageByNumber(
          options.database,
          context.chatId,
          cancellationId.number,
        )
      : await cancelCronMessageByNumber(
          options.database,
          context.chatId,
          cancellationId.number,
        );

  if (result !== "canceled") {
    const label =
      cancellationId.kind === "scheduled"
        ? "Scheduled message"
        : "Repeating message";
    const reason = result === "not_active" ? "is not active" : "was not found";

    return getJsonError(`Cannot cancel scheduled message: ${label} ${reason}.`);
  }

  return await getPlainSchedule(options.database, context.chatId);
};

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
      message: getString(args?.message),
      shortElaboration: getShortElaboration(args),
      at: getString(args?.at),
    });

    return JSON.stringify({
      scheduled_message: {
        id: scheduledMessage.id,
        scheduled_at: scheduledMessage.scheduled_at,
        scheduled_for: formatScheduledAt(scheduledMessage.scheduled_at),
      },
    });
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
      message: getString(args?.message),
      shortElaboration: getShortElaboration(args),
      intervalUnit: interval.intervalUnit,
      intervalValue: interval.intervalValue,
    });

    return JSON.stringify({
      cron_message: {
        id: cronMessage.id,
        interval: formatCronInterval(cronMessage),
      },
    });
  } catch (error) {
    return formatScheduleError(error, "schedule cron message");
  }
};
