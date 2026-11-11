import type { Database } from "../database.ts";
import {
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
    "Create a recurring Telegram reminder using one RFC5545 RRULE, a local start date/time, and an IANA timezone. Use this tool for daily, weekly, monthly, weekday, or every-N-hours reminders. Occurrences must be at least 5 minutes apart per reminder; SECONDLY and nonzero BYSECOND are forbidden. Use UTC for exact elapsed-hour/minute intervals; named timezones keep calendar reminders at local wall-clock times across DST. Missing DST times are skipped and repeated times fire once. Current chat/topic is automatic; up to 10 active reminders per chat. Separate reminders may share a schedule. Never claim creation succeeded until the tool succeeds.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The exact Telegram message to send repeatedly.",
      },
      short_elaboration: {
        type: "string",
        description: "A 1-3 word label, different from the message text.",
      },
      rrule: {
        type: "string",
        description:
          "One RRULE, without DTSTART or other lines. Examples: FREQ=DAILY; FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR; FREQ=HOURLY;INTERVAL=5; FREQ=MINUTELY;INTERVAL=5; FREQ=MONTHLY;BYDAY=1MO. Time defaults to starts_at; BYHOUR/BYMINUTE may select multiple spaced times. Optional COUNT or UTC UNTIL. Unsafe or unprovably spaced combinations are rejected.",
      },
      starts_at: {
        type: "string",
        description:
          "Local recurrence anchor in YYYY-MM-DD HH:mm format, without an offset. For daily at 09:00, use a date at 09:00. For an elapsed interval, express the start in UTC and set timezone=UTC.",
      },
      timezone: {
        type: "string",
        description:
          "Explicit IANA timezone, e.g. Europe/Prague, Europe/Kyiv, or UTC. Infer from user/context; clarify if unknown.",
      },
    },
    required: [
      "message",
      "short_elaboration",
      "rrule",
      "starts_at",
      "timezone",
    ],
    additionalProperties: false,
  },
  strict: true,
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

  try {
    const cronMessage = await createCronMessage(options.database, {
      chatId: context.chatId,
      threadId: context.threadId,
      message: getString(args?.message),
      shortElaboration: getShortElaboration(args),
      rrule: getString(args?.rrule),
      startsAt: getString(args?.starts_at),
      timezone: getString(args?.timezone),
    });

    return JSON.stringify({
      cron_message: {
        id: cronMessage.id,
        recurrence: formatCronInterval(cronMessage),
        rrule: cronMessage.rrule,
        starts_at: cronMessage.starts_at,
        timezone: cronMessage.timezone,
        next_run_at: cronMessage.next_run_at,
      },
    });
  } catch (error) {
    return formatScheduleError(error, "schedule cron message");
  }
};
