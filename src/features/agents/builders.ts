import { formatLocalDateMinute } from "../../utils/date.ts";

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

  return `# Meta
Current local time (${timeZone}): ${formatLocalDateMinute(now)}`;
}

export function buildAgentIdentity(
  description: string,
  names: readonly string[],
  goal: string,
): string {
  return `# You
You are ${description} named ${formatAgentNames(names)} with a goal to ${goal}.
"Laylo" means a sacred genderless creature in Socheslo Mythology.`;
}

export function buildToolInstructions(
  instructions: readonly string[] = [],
): string {
  const rules = [
    "You have callable function tools and built-in capabilities at your disposal. Whenever you need a callable function tool, call it by name with proper parameters. Do not write function tool parameters in a normal response.",
    ...instructions,
  ];

  return `# Tools
${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

export function buildFormattingInstructions(): string {
  return `# Formatting
Write naturally in Markdown when formatting improves readability. Use headings, lists, tables, block quotes, links, inline code, and fenced code blocks as needed.`;
}
