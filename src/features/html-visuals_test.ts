import { test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { fetchHtmlVisualAsset } from "./html-visual-assets.ts";
import { insertHtmlVisuals } from "./html-visuals.ts";

test("visual asset downloads keep local files and services out of the renderer", async () => {
  const signal = AbortSignal.timeout(2_000);
  await rejects(
    fetchHtmlVisualAsset("file:///visual.png", signal),
    /require an HTTP\(S\) URL/,
  );
  for (const host of [
    "localhost",
    "127.0.0.1",
    "[::1]",
    "[::ffff:127.0.0.1]",
  ]) {
    await rejects(
      fetchHtmlVisualAsset(`http://${host}/visual.png`, signal),
      /require a public address/,
    );
  }
});

test("HTML visuals are replaced in order while code and Telegram markup stay intact", async () => {
  const first = "<html lang='en'>\n<body>$5</body>\n</html>";
  const second = "<HTML><body>Second</body></HTML>";
  const sampleCode = "```html\n<html>Example source</html>\n```";
  const table = "<table bordered striped><tr><td>Data</td></tr></table>";
  const input = [
    "Before",
    sampleCode,
    `<!doctype html>\n${first}`,
    table,
    second,
    "After",
  ].join("\n\n");
  const rendered: string[] = [];

  strictEqual(
    await insertHtmlVisuals(input, async (html) => {
      rendered.push(html);
      return `![](tg://photo?id=visual_${rendered.length})`;
    }),
    [
      "Before",
      sampleCode,
      "![](tg://photo?id=visual_1)",
      table,
      "![](tg://photo?id=visual_2)",
      "After",
    ].join("\n\n"),
  );
  deepStrictEqual(rendered, [first, second]);
});

test("failed and unfinished visuals leave the surrounding reply readable", async () => {
  const input =
    "Before\n\n<html><p>Error</p></html>\n\nAfter\n\n<html>Unfinished";
  let attempts = 0;

  strictEqual(
    await insertHtmlVisuals(input, async () => {
      attempts++;
      throw new Error("Render failed");
    }),
    "Before\n\n*Visual unavailable.*\n\nAfter\n\n*Visual unavailable.*",
  );
  strictEqual(attempts, 1);
});

test("cancelling an HTML render aborts reply preparation", async () => {
  const controller = new AbortController();
  await rejects(
    insertHtmlVisuals(
      "<html><p>Visual</p></html>",
      async () => {
        controller.abort();
        controller.signal.throwIfAborted();
        return "";
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});
