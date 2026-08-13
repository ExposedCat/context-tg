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

const TELEGRAM_FORMATTING_INSTRUCTIONS = [
  "<formatting>",
  "Telegram supports the following response formatting:",
  "",
  "**bold text**",
  "__bold text__",
  "*italic text*",
  "_italic text_",
  "~~strikethrough text~~",
  "`inline fixed-width code`",
  "==marked text==",
  "||spoiler||",
  "",
  "[inline URL](https://t.me/) [inline e-mail](mailto:user@example.com) [inline phone number](tel:+123456789) [inline mention of a user](tg://user?id=123456789) ![22:45 tomorrow](tg://time?unix=1647531900&format=wDT) \\#hashtag $USD +12345678901, card: 4242 4242 4242 4242, https://t.me t.me a@t.me /command @username",
  "All the text above was on the same line.",
  "",
  "# Heading 1",
  "## Heading 2",
  "### Heading 3",
  "#### Heading 4",
  "##### Heading 5",
  "###### Heading 6",
  "",
  "Paragraph text",
  "",
  "```python",
  "  print('pre-formatted fixed-width code block written in the Python programming language')",
  "```",
  "",
  "---",
  "",
  "- unordered list item",
  "* unordered list item",
  "+ unordered list item",
  "",
  "1. ordered list item",
  "2. ordered list item",
  "",
  "- [ ] task list item",
  "- [x] completed task list item",
  "",
  ">Block quotation started",
  ">",
  ">Block quotation continued on the next line",
  ">Block quotation continued on the same line",
  ">",
  ">The last line of the block quotation",
  "",
  "![](https://telegram.org/example/photo.jpg)",
  "![](https://telegram.org/example/video.mp4)",
  "![](https://telegram.org/example/audio.mp3)",
  "![](https://telegram.org/example/audio.ogg)",
  "![](https://telegram.org/example/animation.gif)",
  "",
  '![](https://telegram.org/example/photo.jpg "Photo caption")',
  '![](https://telegram.org/example/video.mp4 "Video caption")',
  '![](https://telegram.org/example/audio.mp3 "Audio caption")',
  '![](https://telegram.org/example/audio.ogg "Voice note caption")',
  '![](https://telegram.org/example/animation.gif "Animation caption")',
  "",
  "| Header 1 | Header 2 |",
  "|:---------|:--------:|",
  "| left     | center   |",
  "",
  "Text with a reference[^id1] and another one[^id2].",
  "",
  "[^id1]: Definition of the first footnote.",
  "[^id2]: Definition of the second footnote.",
  "",
  "$$E = mc^2$$",
  "",
  "```math",
  "E = mc^2",
  "```",
  "",
  "## Example Nested Syntax Report for _Q1_",
  "Intro with <u>underlined text</u>, ==marked text==, and $$x^2 + y^2$$.",
  "**Bold _italic <u>underlined italic bold</u> italic_ bold**",
  "<u>In inline tags, nested **markdown** is parsed</u>",
  ">Quote with **bold text, ~~strikethrough, and <tg-spoiler>spoiler</tg-spoiler>~~**, plus [a link](https://t.me/).",
  "",
  "- List item with `code`, <sup>superscript</sup>, <sub>subscript</sub>, and a footnote[^note]",
  "- Another item with **bold <tg-spoiler><code>spoiler code</code></tg-spoiler>**",
  "- Another item with ~~strikethrough and <ins>inserted text</ins>~~",
  "",
  "| Metric | Value |",
  "|:-------|------:|",
  "| Speed  | **42** <sup>ms</sup> |",
  "| Status | <tg-spoiler>ready</tg-spoiler> |",
  "",
  "[^note]: Footnote with _italic text_ and <u>HTML underline</u>.",
  "",
  "---",
  "",
  "# Details blocks can contain Markdown content:",
  "",
  "<details open><summary>Summary with **bold text**</summary>",
  "",
  "### Details heading",
  "- List item with _italic text_",
  "- List item with <tg-spoiler>spoiler</tg-spoiler>",
  "",
  "</details>",
  "",
  "# Collages and slideshows can contain Markdown media blocks:",
  "",
  "<tg-collage>",
  "",
  "![](https://telegram.org/example/photo.jpg)",
  "![](https://telegram.org/example/video.mp4)",
  "",
  "</tg-collage>",
  "",
  "<tg-slideshow>",
  "",
  "![](https://telegram.org/example/photo.jpg)",
  "![](https://telegram.org/example/video.mp4)",
  "",
  "</tg-slideshow>",
  "</formatting>",
].join("\n");

export function buildRespondingInstructions(
  chatId: number,
  rules: readonly string[] = [],
): string {
  return [
    "<responding>",
    "- Do not write your `name :` when responding, write the response right away",
    "- When you want to mention somebody, use only their @username without their Name",
    "- This chat supports $$Latex$$, use double dollar sign envelope to wrap formulas.",
    "- When sending multiple images, prefer tg-collage (all visible) or tg-slideshow (carousel) wrappers.",
    `- You can use this link format \`https://t.me/c/${chatId.toString().replace('-100', '')}/MESSAGE_ID\`, replacing \`MESSAGE_ID\` with message ID to create a link to the message`,
    ...rules.map((rule) => `- ${rule}`),
    TELEGRAM_FORMATTING_INSTRUCTIONS,
    "</responding>",
  ].join("\n");
}
