const MARKDOWN_TOKENS = new RegExp(
  [
    // Match escape pairs first so repeating normalization is safe.
    /\\[\\$`<]/.source,
    // A closing fence uses the same marker and is at least as long. An open
    // fence can run to the end of a progress message.
    /^ {0,3}(?<fence>(?<marker>`|~)\k<marker>{2,})[^\r\n]*(?=\r?$)[\s\S]*?(?:^ {0,3}\k<fence>\k<marker>*[ \t]*(?=\r?$)|(?![\s\S]))/
      .source,
    /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/.source,
    // HTML visuals are standalone blocks in final responses. Keep malformed
    // open blocks intact so delivery can discard them without leaking source.
    /^ {0,3}(?:<!doctype[ \t]+html>[ \t]*\r?\n[ \t]*)?(?<visual><html(?=[\s>])(?:"[^"]*"|'[^']*'|[^'"<>])*>[\s\S]*?(?:(?<visualEnd><\/html\s*>)[ \t]*(?=\r?$)|(?![\s\S])))/
      .source,
    /<!--[\s\S]*?(?:-->|(?![\s\S]))/.source,
    // Telegram treats these bodies as HTML or verbatim LaTeX. Preserve
    // incomplete blocks too while a response is streaming.
    /<(?<tag>table|blockquote|figure|figcaption|pre|code|tg-math-block|tg-math)(?=[\s>])(?:"[^"]*"|'[^']*'|[^'"<>])*>[\s\S]*?(?:<\/\k<tag>\s*>|(?![\s\S]))/
      .source,
    /<\/?[a-z][\w-]*(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*>/.source,
    /\$/.source,
  ].join("|"),
  "gim",
);

export function getRichMarkdownHtmlBlocks(text: string) {
  if (!/<html[\s>]/i.test(text)) return [];

  return Array.from(text.matchAll(MARKDOWN_TOKENS)).flatMap((match) => {
    const html = match.groups?.visual;
    return html
      ? [
          {
            start: match.index,
            end: match.index + match[0].length,
            html,
            complete: Boolean(match.groups?.visualEnd),
          },
        ]
      : [];
  });
}

export function stripRichMarkdownHtmlBlocks(text: string): string {
  const blocks = getRichMarkdownHtmlBlocks(text);
  for (const { start, end } of blocks.reverse()) {
    text = text.slice(0, start) + text.slice(end);
  }
  return text;
}

/** Escape dollar signs where Telegram parses Markdown text. */
export function normalizeRichMarkdown(text: string): string {
  return text.includes("$")
    ? text.replace(MARKDOWN_TOKENS, (token) => (token === "$" ? "\\$" : token))
    : text;
}
