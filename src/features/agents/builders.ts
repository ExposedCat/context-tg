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
