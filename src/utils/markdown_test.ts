import { strictEqual } from "node:assert";
import { normalizeRichMarkdown } from "./markdown.ts";

Deno.test("turns Unicode bullet lines into a list with explicit paragraph boundaries", () => {
  const intro = "Основа реальная, но отсутствие ретуши не доказано.";
  const items = [
    "Слева — Барбера Торнхилл: [источник](https://example.com/left).",
    "В центре — Келли Леффлер. Ролик не доказывает отсутствие ретуши.",
    "Правая фотография обрезана — её надёжно не проверить.",
  ];
  const conclusion = "Итог: подпись выдаёт непроверенное утверждение за факт.";
  for (const newline of ["\n", "\r\n"]) {
    const input = [intro, ...items.map((item) => `• ${item}`), conclusion].join(
      newline,
    );
    const expected = [
      intro,
      "",
      ...items.map((item) => `- ${item}`),
      "",
      conclusion,
    ].join(newline);
    strictEqual(normalizeRichMarkdown(input), expected);
    strictEqual(normalizeRichMarkdown(expected), expected);
  }
});

Deno.test("preserves list spacing, Markdown lists, and literal bullet content", () => {
  const list = "• First\n• Second";
  strictEqual(normalizeRichMarkdown(list), "- First\n- Second");
  strictEqual(
    normalizeRichMarkdown(`Intro\n\n${list}\n\nAfter`),
    "Intro\n\n- First\n- Second\n\nAfter",
  );
  for (const input of [
    "Intro\n\n- First\n- Second\n\nAfter",
    "Symbols: a • b • c",
    "`• inline code`",
    "`multiline code\n• literal bullet\n`",
    `\`\`\`text\n${list}\n\`\`\``,
    `~~~\n${list}\n~~~`,
    `<pre>\n${list}\n</pre>`,
    `<code>\n${list}\n</code>`,
    "    • indented code",
    "> • quoted text",
    "\\• escaped bullet",
    "•no space",
    "[link](https://example.com/•path)",
  ]) {
    strictEqual(normalizeRichMarkdown(input), input);
  }
});

Deno.test("normalizes tables and dollar signs together without changing LaTeX", () => {
  const input = "Prices | Price | Formula | | --- | --- | | $16 | $$x + 1$$ |";
  const expected =
    "Prices\n\n| Price | Formula |\n| --- | --- |\n| \\$16 | $$x + 1$$ |";
  strictEqual(normalizeRichMarkdown(input), expected);
  strictEqual(normalizeRichMarkdown(expected), expected);
});

Deno.test("restores the reported flattened Russian table", () => {
  const intro =
    "Статистика OpenRouter в обработке Dirac (https://dirac.run/labs-market-share):";
  const rows = [
    "| Доля токенов | 19 марта 2026 | 10 октября 2026 |",
    "|---|---:|---:|",
    "| Модели с открытыми весами | 40,7% | 70,6% |",
    "| Закрытые модели | 59,3% | 29,4% |",
    "| Anthropic | 21,9% | 10,7% |",
  ];
  strictEqual(
    normalizeRichMarkdown(`${intro} ${rows.join(" ")}`),
    `${intro}\n\n${rows.join("\n")}`,
  );
});

Deno.test("separates tables from prose with missing or single newlines", () => {
  const table = "| A | B |\n|:---|---:|\n| 1 | 2 |";
  for (const gap of [" ", "\n", "\r\n"]) {
    strictEqual(
      normalizeRichMarkdown(`Intro${gap}${table}${gap}After`),
      `Intro\n\n${table}\n\nAfter`,
    );
  }
});

Deno.test("normalization preserves valid tables and is idempotent", () => {
  const valid = "Intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter";
  strictEqual(normalizeRichMarkdown(valid), valid);
  const fixed = normalizeRichMarkdown(valid.replaceAll("\n", " "));
  strictEqual(normalizeRichMarkdown(fixed), fixed);
});

Deno.test("handles multiple tables and empty cells", () => {
  const table = "| A | B | | --- | --- | | 1 | |";
  const expected = "| A | B |\n| --- | --- |\n| 1 | |";
  strictEqual(
    normalizeRichMarkdown(`First ${table} Second ${table} Done`),
    `First\n\n${expected}\n\nSecond\n\n${expected}\n\nDone`,
  );
});

Deno.test("preserves inline code, escaped pipes, and links in cells", () => {
  const header = "| `a|b` | Link |";
  const row = "| a\\|b | [source](https://example.com/a|b) |";
  strictEqual(
    normalizeRichMarkdown(`Intro ${header} | --- | --- | ${row}`),
    `Intro\n\n${header}\n| --- | --- |\n${row}`,
  );
});

Deno.test("leaves literal code, nested tables, and ambiguous prose untouched", () => {
  const table = "| A | B | | --- | --- | | 1 | 2 |";
  for (const input of [
    `\`${table}\``,
    `\`\`${table}\`\``,
    `\`\`\`markdown\n${table}\n\`\`\``,
    `~~~~\n${table}\n~~~~`,
    `\`\`\`\n${table}`,
    `<pre>${table}</pre>`,
    `<code>${table}</code>`,
    `    ${table}`,
    `> ${table}`,
    `- ${table}`,
    "a | b | c",
    "||spoiler||",
    "| A | B | C |\n| --- | --- |",
    "| A | B |\n\n| --- | --- |",
  ]) {
    strictEqual(normalizeRichMarkdown(input), input);
  }
});

Deno.test("normalizes tables after a fenced block without editing the block", () => {
  const code = "```\n| A | B | | --- | --- |\n```";
  strictEqual(
    normalizeRichMarkdown(`${code}\nIntro | A | B | | --- | --- |`),
    `${code}\nIntro\n\n| A | B |\n| --- | --- |`,
  );
});

Deno.test("preserves indentation of code following a table", () => {
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  strictEqual(
    normalizeRichMarkdown(`${table}\n    literal code`),
    `${table}\n\n    literal code`,
  );
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
