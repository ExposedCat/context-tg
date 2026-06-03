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
This formatting limitation applies to normal chat responses and captions, not to send_html_report html_string.
For regular responses, Markdown and HTML are NOT supported. You can ONLY use this small subset when needed:
- <b> for bold
- <code> for monospace snippets: literal names, values, etc.
- <code lang=""> for monospace code snippets of a specific language
- <a href=""> for links, but not citations
- <blockquote> for quoted passages. Use <blockquote expandable> for longer citations.
Do not nest blockquotes.
Use regular dashes for lists.`;
}
