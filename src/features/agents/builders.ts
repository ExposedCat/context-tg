import { formatLocalDateMinute } from "../../utils/date.ts";
import { escapeXmlAttribute } from "../../utils/text.ts";

export function formatAgentNames(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(", ");
}

export function joinPromptSections(
  sections: Array<string | undefined>,
): string {
  return sections
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

export function buildMetadataInstructions(): string {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [date, time] = formatLocalDateMinute(now).split(" ");

  return `<metadata>
  <time localTimeZone="${escapeXmlAttribute(timeZone)}" date="${date}" time="${time}" />
</metadata>`;
}

export function buildAgentIdentity(
  description: string,
  names: readonly string[],
  goal: string,
): string {
  return `- You are ${description} named ${formatAgentNames(names)} with a goal to ${goal}`;
}

export function buildRespondingInstructions(
  chatId: number,
  rules: readonly string[] = [],
): string {
  return [
    "<responding>",
    "- Do not write your `name :` when responding, write the response right away",
    "- When you want to mention somebody, use only their @username without their Name",
    "- This chat supports $$Latex$$, use double dollar sign envelope to wrap formulas.",
    `- You can use this link format \`https://t.me/c/${chatId.toString().replace('-100', '')}/MESSAGE_ID\`, replacing \`MESSAGE_ID\` with message ID to create a link to the message`,
    ...rules.map((rule) => `- ${rule}`),
    "</responding>",
  ].join("\n");
}
