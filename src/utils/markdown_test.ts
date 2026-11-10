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

test("normalizeRichMarkdown preserves double-dollar LaTeX", () => {
  strictEqual(
    normalizeRichMarkdown("The total is $$13 + 3 = 16$$, or $16."),
    "The total is $$13 + 3 = 16$$, or \\$16.",
  );
});

test("normalizeRichMarkdown handles runs of dollar signs in pairs", () => {
  strictEqual(normalizeRichMarkdown("$$$ $$$$ $$$$$"), "$$\\$ $$$$ $$$$\\$");
});

test("normalizeRichMarkdown does not double-escape dollar signs", () => {
  strictEqual(
    normalizeRichMarkdown("Already \\$escaped and $not."),
    "Already \\$escaped and \\$not.",
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
