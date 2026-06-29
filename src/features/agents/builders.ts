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
  return `# Meta
Current time (ISO): ${new Date().toISOString()}`;
}

export function buildAgentIdentity(
  description: string,
  names: readonly string[],
  goal: string,
): string {
  return `# You
You are ${description} named ${formatAgentNames(
    names,
  )} with a goal to ${goal}.`;
}

export function buildToolInstructions(
  instructions: readonly string[] = [],
): string {
  const rules = [
    "You have tools at your disposal. Whenever you need one, call the tool by name with proper parameters. Do not write tool parameters in a normal response.",
    ...instructions,
  ];

  return `# Tools
${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

export function buildFormattingInstructions(): string {
  return `# Formatting
Write naturally in Markdown when formatting improves readability. Use headings, lists, tables, block quotes, links, inline code, and fenced code blocks as needed.`;
}
