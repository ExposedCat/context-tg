import { formatLocalDateMinute } from "../utils/date.ts";
import { escapeXml, escapeXmlAttribute } from "../utils/text.ts";

export type PromptMessageAttributes = {
  id?: string | number;
  sender?: string;
  sender_id?: string | number;
  media_group_id?: string;
  date?: string;
  time?: string;
};

export type PromptReplyReference = {
  attributes: PromptMessageAttributes;
  excerpt?: string;
  forwardedFrom?: PromptMessageAttributes;
};

function formatXmlAttributes(attributes: PromptMessageAttributes): string {
  return Object.entries(attributes)
    .flatMap(([key, value]) =>
      value === undefined
        ? []
        : [`${key}="${escapeXmlAttribute(String(value))}"`],
    )
    .join(" ");
}

function formatOpenTag(
  tagName: string,
  attributes: PromptMessageAttributes,
): string {
  const formattedAttributes = formatXmlAttributes(attributes);
  return formattedAttributes
    ? `<${tagName} ${formattedAttributes}>`
    : `<${tagName}>`;
}

function formatContentElement(content: string): string {
  return `  <content>${escapeXml(content)}</content>`;
}

function formatForwardedFromXml(
  attributes: PromptMessageAttributes | undefined,
  indent: string,
): string[] {
  return attributes
    ? [
        `${indent}${formatOpenTag("forwarded_from", attributes).slice(0, -1)} />`,
      ]
    : [];
}

function formatReplyReferenceXml(
  reply: PromptReplyReference | undefined,
): string | undefined {
  if (!reply) {
    return undefined;
  }

  const openTag = formatOpenTag("in_reply_to_message", reply.attributes);

  if (!reply.excerpt && !reply.forwardedFrom) {
    return `  ${openTag.slice(0, -1)} />`;
  }

  return [
    `  ${openTag}`,
    ...formatForwardedFromXml(reply.forwardedFrom, "    "),
    ...(reply.excerpt
      ? [`    <excerpt>${escapeXml(reply.excerpt)}</excerpt>`]
      : []),
    "  </in_reply_to_message>",
  ].join("\n");
}

export function getPromptDateTimeFromEpochSeconds(
  value: number | undefined,
): { date: string; time: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  const [date, time] = formatLocalDateMinute(new Date(value * 1000)).split(" ");
  return date && time ? { date, time } : undefined;
}

export function formatPromptMessageXml(
  attributes: PromptMessageAttributes,
  content: string,
  options: {
    reply?: PromptReplyReference;
    forwardedFrom?: PromptMessageAttributes;
  } = {},
): string {
  const replyReference = formatReplyReferenceXml(options.reply);

  return [
    formatOpenTag("message", attributes),
    ...formatForwardedFromXml(options.forwardedFrom, "  "),
    ...(replyReference ? [replyReference] : []),
    formatContentElement(content),
    "</message>",
  ].join("\n");
}

export function formatSystemPromptMessageXml(content: string): string {
  return formatPromptMessageXml({ sender: "System" }, content);
}
