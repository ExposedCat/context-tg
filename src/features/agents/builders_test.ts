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
  const richRespondingGuidance = [
    "Include a concise visual (<media-html-freeform> or a matching specialized <media-*> tag) in every explanation",
    "Let the visual carry the explanation instead of writing multi-paragraph prose.",
    "Always use <media-*> tags for graphics, diagrams, schematics, and charts",
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
    "<media-html-freeform>…</media-html-freeform>",
    "<media-html-freeform><style>",
    "<media-chart viewBox=",
    "<media-plot>",
    "<media-flow>",
    "<media-mermaid>",
    "<media-intervals unit=",
    "<media-stacked-bars unit=",
    "<media-timebands>",
    "Consecutive graphic tags render as one image.",
  ];

  for (const agent of [normalAgent, guestAgent, trollAgent]) {
    const instructions = agent.buildInstructions(-1001234567890);
    const richFormatting = agent.id !== "troll";
    const respondingSection =
      instructions.match(/<responding>[\s\S]*?<\/responding>/)?.[0] ?? "";
    const formattingSection =
      instructions.match(/<formatting>[\s\S]*?<\/formatting>/)?.[0] ?? "";
    for (const syntax of mediaSyntax) {
      ok(formattingSection.includes(syntax), `${agent.id}: missing ${syntax}`);
    }
    for (const guidance of richRespondingGuidance) {
      strictEqual(
        respondingSection.includes(guidance),
        richFormatting,
        `${agent.id} responding: ${guidance}`,
      );
      strictEqual(
        formattingSection.includes(guidance),
        false,
        `${agent.id} formatting should not contain behavioral rule: ${guidance}`,
      );
    }
    for (const syntax of richSyntax) {
      strictEqual(
        formattingSection.includes(syntax),
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
