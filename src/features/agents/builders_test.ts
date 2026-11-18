import { test } from "bun:test";
import { ok, strictEqual } from "node:assert";
import { buildRespondingInstructions } from "./builders.ts";

test("responding instructions describe Telegram rich formatting", () => {
  const instructions = buildRespondingInstructions(-1001234567890);
  const supportedExamples = [
    "When sending multiple images, prefer tg-collage (all visible) or tg-slideshow (carousel) wrappers.",
    "**bold text**",
    "A line with **Markdown formatting**<br>Another line in the same paragraph.",
    "||spoiler||",
    "[inline mention of a user](tg://user?id=123456789)",
    "# Heading 1",
    "```python",
    "- [x] completed task list item",
    ">Block quotation started",
    "<blockquote expandable>Long excerpt begins.<br>Long excerpt continues.<cite>Author or source</cite></blockquote>",
    '![](https://telegram.org/example/photo.jpg "Photo caption")',
    '<figure><img src="https://telegram.org/example/photo.jpg"/><figcaption>Photo caption<cite>Photo credit</cite></figcaption></figure>',
    "![](tg://photo?id=IMAGE_ID)",
    "![](tg://document?id=IMAGE_ID)",
    "Always preserve the exact URI and ID",
    "<table bordered striped>",
    '<tr><th align="left">Item</th><th align="right">Value</th></tr>',
    '<td align="right"><b>42</b> <sup>ms</sup></td>',
    "[^id1]: Definition of the first footnote.",
    "<tg-math>x^2 + y^2</tg-math>",
    "<tg-math-block>E = mc^2</tg-math-block>",
    "```math\nE = mc^2\n```",
    "<details open><summary>Summary with **bold text**</summary>",
    "<tg-collage>",
    "<tg-slideshow>",
    "<figcaption>Collage caption<cite>Media credit</cite></figcaption></tg-collage>",
    "<figcaption>Slideshow caption<cite>Media credit</cite></figcaption></tg-slideshow>",
  ];

  for (const example of supportedExamples) {
    ok(
      instructions.includes(example),
      `Missing formatting example: ${example}`,
    );
  }

  strictEqual(instructions.includes("$$"), false);
  strictEqual(instructions.includes("To insert media into the message"), false);
  strictEqual(
    instructions.includes("To display multiple inserted media as a slideshow"),
    false,
  );
});
