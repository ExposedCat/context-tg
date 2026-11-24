import { test } from "bun:test";
import { ok, strictEqual } from "node:assert";
import { guestAgent, normalAgent, trollAgent } from "./index.ts";

test("agents receive formatting and memory guidance for their capabilities", () => {
  const mediaSyntax = [
    "![](tg://photo?id=IMAGE_ID)",
    "![](tg://document?id=IMAGE_ID)",
    "<tg-collage>",
    "<tg-slideshow>",
    "<figcaption>",
  ];
  const richSyntax = [
    "<br>",
    "||spoiler||",
    "(tg://user?id=USER_ID)",
    "<blockquote expandable>",
    "<details><summary>",
    "<table bordered striped>",
    'align="right"',
    "<tg-math>",
    "<tg-math-block>",
    "standalone <html> blocks",
  ];

  for (const agent of [normalAgent, guestAgent, trollAgent]) {
    const instructions = agent.buildInstructions(-1001234567890);
    const richFormatting = agent.id !== "troll";
    for (const syntax of mediaSyntax) {
      ok(instructions.includes(syntax), `${agent.id}: missing ${syntax}`);
    }
    for (const syntax of richSyntax) {
      strictEqual(
        instructions.includes(syntax),
        richFormatting,
        `${agent.id}: ${syntax}`,
      );
    }
    strictEqual(instructions.includes("<memory>"), agent.id !== "guest");
    ok(
      instructions.includes(
        "Current chat participants went PEGI18 verification",
      ),
    );
  }
});
