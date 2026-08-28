import { ok, strictEqual } from "node:assert";
import { buildRespondingInstructions } from "./builders.ts";

Deno.test("responding instructions describe Telegram rich formatting", () => {
  const instructions = buildRespondingInstructions(-1001234567890);
  const supportedExamples = [
    "When sending multiple images, prefer tg-collage (all visible) or tg-slideshow (carousel) wrappers.",
    "**bold text**",
    "||spoiler||",
    "[inline mention of a user](tg://user?id=123456789)",
    "# Heading 1",
    "```python",
    "- [x] completed task list item",
    ">Block quotation started",
    '![](https://telegram.org/example/photo.jpg "Photo caption")',
    "![](tg://photo?id=IMAGE_ID)",
    "using the exact returned ID",
    "|:---------|:--------:|",
    "[^id1]: Definition of the first footnote.",
    "$$E = mc^2$$",
    "<details open><summary>Summary with **bold text**</summary>",
    "<tg-collage>",
    "<tg-slideshow>",
  ];

  for (const example of supportedExamples) {
    ok(
      instructions.includes(example),
      `Missing formatting example: ${example}`,
    );
  }

  strictEqual(instructions.includes("To insert media into the message"), false);
  strictEqual(
    instructions.includes("To display multiple inserted media as a slideshow"),
    false,
  );
});
