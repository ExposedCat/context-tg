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

export function buildFormattingInstructions(): string {
  return `# Formatting
Write naturally in Markdown when formatting improves readability. Use headings, lists, tables, block quotes, links, inline code, and fenced code blocks as needed.`;
}
