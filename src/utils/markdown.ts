const GRAPHIC_ELEMENTS = {
  bars: ["dl", "v-bars"],
  columns: ["div", "v-cols"],
  composition: ["div", ""],
  heatmap: ["div", ""],
  meter: ["div", "v-meter"],
  range: ["div", "v-range"],
  chart: ["svg", "v-chart"],
  flow: ["ol", "v-flow"],
  plot: ["media-plot", ""],
} as const;

const DATA_GRAPHICS = ["mermaid", "intervals", "stacked-bars", "timebands"];
const KIT_GRAPHICS = Object.keys(GRAPHIC_ELEMENTS).join("|");
const GRAPHIC_TAG = `(?:media-(?:${KIT_GRAPHICS}|${DATA_GRAPHICS.join("|")})|tg-(?:${KIT_GRAPHICS}))`;
const GRAPHIC_OPEN = `<${GRAPHIC_TAG}(?=[\\s>]|$)`;

const MARKDOWN_TOKENS = new RegExp(
  [
    // Match escape pairs first so repeating normalization is safe.
    /\\[\\$`<]/.source,
    // A closing fence uses the same marker and is at least as long. An open
    // fence can run to the end of a progress message.
    /^ {0,3}(?<fence>(?<marker>`|~)\k<marker>{2,})[^\r\n]*(?=\r?$)[\s\S]*?(?:^ {0,3}\k<fence>\k<marker>*[ \t]*(?=\r?$)|(?![\s\S]))/
      .source,
    /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/.source,
    // Continue to recognize standalone HTML from older conversations.
    /^ {0,3}(?:<!doctype[ \t]+html>[ \t]*\r?\n[ \t]*)?(?<visual><html(?=[\s>])(?:"[^"]*"|'[^']*'|[^'"<>])*>[\s\S]*?(?:(?<visualEnd><\/html\s*>)[ \t]*(?=\r?$)|(?![\s\S])))/
      .source,
    /<!--[\s\S]*?(?:-->|(?![\s\S]))/.source,
    // A following graphic starts a new block even if the previous one was
    // missing its closing tag. Incomplete blocks are hidden during streaming.
    `<(?<graphic>${GRAPHIC_TAG})(?=[\\s>])(?<attributes>(?:"[^"]*"|'[^']*'|[^'"<>])*)>(?<body>[\\s\\S]*?)(?:(?<graphicEnd></\\k<graphic>\\s*>)|(?=${GRAPHIC_OPEN})|(?![\\s\\S]))`,
    `(?<partialGraphic>${GRAPHIC_OPEN}[^<>]*(?![\\s\\S]))`,
    // Telegram treats these bodies as HTML or verbatim LaTeX. Preserve
    // incomplete blocks too while a response is streaming.
    /<(?<tag>table|blockquote|figure|figcaption|pre|code|tg-math-block|tg-math)(?=[\s>])(?:"[^"]*"|'[^']*'|[^'"<>])*>[\s\S]*?(?:<\/\k<tag>\s*>|(?![\s\S]))/
      .source,
    /<\/?[a-z][\w-]*(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*>/.source,
    /\$/.source,
  ].join("|"),
  "gim",
);

type VisualBlock = {
  start: number;
  end: number;
  html: string;
  complete: boolean;
  graphic: boolean;
};

function graphicHtml(name: string, attributes: string, body: string): string {
  const suffix = name.replace(/^(?:media|tg)-/, "");
  const [element, className] = GRAPHIC_ELEMENTS[
    suffix as keyof typeof GRAPHIC_ELEMENTS
  ] ?? [name, ""];
  if (!className) return `<${element}${attributes}>${body}</${element}>`;

  let hasClass = false;
  const htmlAttributes = attributes.replace(
    /\s+class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>]+))|"[^"]*"|'[^']*'/gi,
    (token, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted;
      if (value === undefined) return token;
      hasClass = true;
      return ` class="${className} ${value.replaceAll('"', "&quot;")}"`;
    },
  );
  return `<${element}${hasClass ? "" : ` class="${className}"`}${htmlAttributes}>${body}</${element}>`;
}

export function getRichMarkdownVisualBlocks(text: string): VisualBlock[] {
  if (!/<(?:html|media-|tg-)/i.test(text)) return [];

  const blocks: VisualBlock[] = [];
  for (const match of text.matchAll(MARKDOWN_TOKENS)) {
    const {
      visual,
      visualEnd,
      graphic,
      graphicEnd,
      partialGraphic,
      attributes,
      body,
    } = match.groups ?? {};
    if (!visual && !graphic && !partialGraphic) continue;

    const start = match.index;
    const end = start + match[0].length;
    const complete = Boolean(visualEnd || graphicEnd);
    const html =
      visual ??
      (complete
        ? graphicHtml(graphic.toLowerCase(), attributes ?? "", body ?? "")
        : "");
    const previous = blocks.at(-1);
    if (
      graphic &&
      complete &&
      previous?.graphic &&
      previous.complete &&
      !text.slice(previous.end, start).trim()
    ) {
      previous.end = end;
      previous.html += `\n${html}`;
    } else {
      blocks.push({
        start,
        end,
        html,
        complete,
        graphic: Boolean(graphic || partialGraphic),
      });
    }
  }
  return blocks;
}

export function stripRichMarkdownVisualBlocks(text: string): string {
  let result = "";
  let cursor = 0;
  for (const { start, end } of getRichMarkdownVisualBlocks(text)) {
    result += text.slice(cursor, start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

/** Escape dollar signs where Telegram parses Markdown text. */
export function normalizeRichMarkdown(text: string): string {
  return text.includes("$")
    ? text.replace(MARKDOWN_TOKENS, (token) => (token === "$" ? "\\$" : token))
    : text;
}
