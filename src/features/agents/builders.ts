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

const SHARED_RESPONDING_RULES = [
  "Do not write your `name :` when responding, write the response right away",
  "When you want to mention somebody, use only their @username without their Name",
  "Whenever talking about anything in real world, always search web a few times and read a few articles before every response, to consistently stay up to date.",
  "This chat supports $Latex$, so you need to escape \\$ whenever you want to send a regular dollar sign."
] as const;

export function buildRespondingInstructions(
  rules: readonly string[] = [],
): string {
  return [
    "<responding>",
    ...SHARED_RESPONDING_RULES.map((rule) => `- ${rule}`),
    ...rules.map((rule) => `- ${rule}`),
    "</responding>",
  ].join("\n");
}
