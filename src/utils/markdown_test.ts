import { strictEqual } from "node:assert";
import { normalizeRichMarkdown } from "./markdown.ts";

Deno.test("preserves Markdown structure and explicit line breaks without guessing", () => {
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

Deno.test("normalizeRichMarkdown escapes ordinary dollar signs", () => {
  strictEqual(
    normalizeRichMarkdown("It was just 13$. However, this is 3$"),
    "It was just 13\\$. However, this is 3\\$",
  );
});

Deno.test("normalizeRichMarkdown preserves double-dollar LaTeX", () => {
  strictEqual(
    normalizeRichMarkdown("The total is $$13 + 3 = 16$$, or $16."),
    "The total is $$13 + 3 = 16$$, or \\$16.",
  );
});

Deno.test("normalizeRichMarkdown handles runs of dollar signs in pairs", () => {
  strictEqual(normalizeRichMarkdown("$$$ $$$$ $$$$$"), "$$\\$ $$$$ $$$$\\$");
});

Deno.test("normalizeRichMarkdown does not double-escape dollar signs", () => {
  strictEqual(
    normalizeRichMarkdown("Already \\$escaped and $not."),
    "Already \\$escaped and \\$not.",
  );
});
