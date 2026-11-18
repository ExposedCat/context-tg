import { test } from "bun:test";
import { strictEqual } from "node:assert";
import { normalizeRichMarkdown } from "./markdown.ts";

test("preserves Markdown structure and explicit line breaks without guessing", () => {
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  for (const input of [
    `Intro\n${table}\nAfter`,
    `Intro\n\n${table}\n\nAfter`,
    "Intro | A | B | | --- | --- | | 1 | 2 |",
    "Intro\n• First\n• Second\nAfter",
    "Intro\n\n- First\n- Second\n\nAfter",
    "First<br>Second",
    '<table bordered striped>\n<tr><th align="left">Item</th><th align="right">Value</th></tr>\n<tr><td align="left">Example</td><td align="right">42</td></tr>\n</table>',
    "First  \nSecond",
    "First\\\nSecond",
    "First\r\nSecond\r\n\r\nAfter",
    "```text\n• literal bullet\n| literal pipe |\n```",
    "`literal\nnewline`",
    "<pre>First\nSecond</pre>",
    "<details><summary>Title</summary>\n\n- First\n- Second\n\n</details>",
  ]) {
    strictEqual(normalizeRichMarkdown(input), input);
  }
});

test("normalizeRichMarkdown escapes ordinary dollar signs", () => {
  strictEqual(
    normalizeRichMarkdown("It was just 13$. However, this is 3$"),
    "It was just 13\\$. However, this is 3\\$",
  );
});

test("normalizeRichMarkdown escapes paired dollars in prose", () => {
  strictEqual(
    normalizeRichMarkdown("The total is $$13 + 3 = 16$$, or $16."),
    "The total is \\$\\$13 + 3 = 16\\$\\$, or \\$16.",
  );
});

test("normalizeRichMarkdown escapes each dollar in a run", () => {
  const escaped = normalizeRichMarkdown("$$$ $$$$");
  strictEqual(escaped, String.raw`\$\$\$ \$\$\$\$`);
  strictEqual(normalizeRichMarkdown(escaped), escaped);
});

test("normalizeRichMarkdown does not double-escape dollar signs", () => {
  strictEqual(
    normalizeRichMarkdown("Already \\$escaped and $not."),
    "Already \\$escaped and \\$not.",
  );
  strictEqual(
    normalizeRichMarkdown(String.raw`\\$price and \\\$price`),
    String.raw`\\\$price and \\\$price`,
  );
});

test("normalizeRichMarkdown preserves explicit inline and multiline math", () => {
  const inline = String.raw`<tg-math>\text{\$5}</tg-math>`;
  const expression = String.raw`p\in D,\quad x\in D
\quad\Longrightarrow\quad
H(x)=(1-s)p+sx\in D.`;
  const block = `<tg-math-block>${expression}</tg-math-block>`;
  const fence = [
    "```math",
    expression,
    String.raw`\quad\text{\$5}`,
    "```",
  ].join("\n");
  strictEqual(
    normalizeRichMarkdown(`$5 and ${inline}\n\n${block}\n\n${fence}\n\n$10`),
    `\\$5 and ${inline}\n\n${block}\n\n${fence}\n\n\\$10`,
  );
});

test("normalizeRichMarkdown preserves dollars inside code", () => {
  const code = [
    "`echo $PATH`",
    "`` A ` followed by $$ ``",
    '````sh\r\necho "$HOME"\r\n```\r\necho "$$"\r\n`````',
    '~~~sh\necho "$HOME"\n~~~',
    "<pre><code>$HOME</code></pre>",
    "````sh\necho $HOME",
  ];
  for (const span of code) {
    strictEqual(normalizeRichMarkdown(`$5\n\n${span}`), `\\$5\n\n${span}`);
  }
});

test("normalizeRichMarkdown preserves dollars in attributed HTML", () => {
  const quote =
    "<blockquote expandable>The fare was $5.<cite>Author</cite></blockquote>";
  const figure =
    '<figure><img src="https://example.org/$image"/><figcaption>A $5 fare<cite>Author</cite></figcaption></figure>';
  const collage =
    '<tg-collage><img src="https://example.org/$image"/><figcaption>A $5 fare<cite>Author</cite></figcaption></tg-collage>';
  const link = '<a href="https://example.org/>/$value">$5</a>';
  strictEqual(
    normalizeRichMarkdown(`${quote}\n\n${figure}\n\n${collage}\n\n${link}`),
    `${quote}\n\n${figure}\n\n${collage}\n\n${link.replace("$5", "\\$5")}`,
  );
});

test("normalizeRichMarkdown leaves dollars in HTML tables unescaped", () => {
  const table =
    '<table bordered striped>\n<tr><th>Price $</th></tr>\n<tr><td align="right"><b>$13</b> / 3$ / $$x$$</td></tr>\n</table>';
  strictEqual(
    normalizeRichMarkdown(`Before $16.\n\n${table}\n\nAfter 3$.`),
    `Before \\$16.\n\n${table}\n\nAfter 3\\$.`,
  );
});

test("normalizeRichMarkdown handles multiple HTML tables and tag casing", () => {
  const first = "<TABLE><TR><TD>$13</TD></TR></TABLE>";
  const second = "<table\nstriped><tr><td>3$</td></tr></table >";
  strictEqual(
    normalizeRichMarkdown(`${first}\n$16\n${second}\n$20`),
    `${first}\n\\$16\n${second}\n\\$20`,
  );
});

test("normalizeRichMarkdown leaves dollars in streaming HTML tables unescaped", () => {
  const partial = '<table bordered striped>\n<tr><td align="right">$13';
  strictEqual(
    normalizeRichMarkdown(`Before $16.\n\n${partial}`),
    `Before \\$16.\n\n${partial}`,
  );
});

test("normalizeRichMarkdown still escapes dollars in Markdown tables and other tags", () => {
  strictEqual(
    normalizeRichMarkdown(
      "| Price |\n| --- |\n| $13 |\n<table-note>$3</table-note>",
    ),
    "| Price |\n| --- |\n| \\$13 |\n<table-note>\\$3</table-note>",
  );
});
