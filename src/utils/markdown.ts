const MARKDOWN_TOKENS = new RegExp(
  [
    // Match escape pairs first so repeating normalization is safe.
    /\\[\\$`<]/.source,
    // A closing fence uses the same marker and is at least as long. An open
    // fence can run to the end of a progress message.
    /^ {0,3}(?<fence>(?<marker>`|~)\k<marker>{2,})[^\r\n]*(?=\r?$)[\s\S]*?(?:^ {0,3}\k<fence>\k<marker>*[ \t]*(?=\r?$)|(?![\s\S]))/
      .source,
    /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/.source,
    // Telegram treats these bodies as HTML or verbatim LaTeX. Preserve
    // incomplete blocks too while a response is streaming.
    /<(?<tag>table|blockquote|figure|figcaption|pre|code|tg-math-block|tg-math)(?=[\s>])(?:"[^"]*"|'[^']*'|[^'"<>])*>[\s\S]*?(?:<\/\k<tag>\s*>|(?![\s\S]))/
      .source,
    /<\/?[a-z][\w-]*(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*>/.source,
    /\$/.source,
  ].join("|"),
  "gim",
);

/** Escape dollar signs where Telegram parses Markdown text. */
export function normalizeRichMarkdown(text: string): string {
  return text.includes("$")
    ? text.replace(MARKDOWN_TOKENS, (token) => (token === "$" ? "\\$" : token))
    : text;
}
