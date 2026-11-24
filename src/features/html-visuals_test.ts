import { test } from "bun:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { stripRichMarkdownVisualBlocks } from "../utils/markdown.ts";
import { fetchHtmlVisualAsset } from "./html-visual-assets.ts";
import {
  getHtmlVisualKit,
  HTML_VISUAL_KIT_FONT_PATH,
} from "./html-visual-kit.ts";
import { insertHtmlVisuals } from "./html-visuals.ts";
import { expandMediaCharts } from "./media-charts.ts";

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

test("adjacent media tags and legacy aliases render together among native Telegram blocks", async () => {
  const bars =
    '<media-bars style="--label:90px"><div><dt>A</dt><dd>5</dd></div></media-bars>';
  const plot = '<media-plot height="150">y = x^2</media-plot>';
  const native =
    "<table bordered striped><tr><td>Exact value</td></tr></table>\n\n<tg-math>x^2</tg-math>";
  const flow =
    "<TG-FLOW aria-label=\"A > B\" CLASS='is-vertical'><li><b>A</b></li><li><b>B</b></li></TG-FLOW>";
  const literal = `\`\`${plot}\`\`\n\n\`\`\`html\n${bars}\n\`\`\`\n\n\\<media-plot>`;
  const input = `${literal}\n\nIntro ${bars}\n\n${plot}\n${native}\n\n${flow} End`;
  const rendered: string[] = [];

  strictEqual(
    await insertHtmlVisuals(input, async (html) => {
      rendered.push(html);
      return `![](tg://photo?id=visual_${rendered.length})`;
    }),
    `${literal}\n\nIntro\n\n![](tg://photo?id=visual_1)\n\n${native}\n\n![](tg://photo?id=visual_2)\n\nEnd`,
  );
  deepStrictEqual(rendered, [
    `<dl class="v-bars" style="--label:90px"><div><dt>A</dt><dd>5</dd></div></dl>\n${plot}`,
    '<ol aria-label="A > B" class="v-flow is-vertical"><li><b>A</b></li><li><b>B</b></li></ol>',
  ]);
});

test("incomplete graphic tags stay out of progress and do not swallow a later graphic", async () => {
  const plot = "<media-plot>y = x^2</media-plot>";
  const input = `Before\n\n<media-bars>unfinished\n${plot}\n\nAfter`;
  strictEqual(stripRichMarkdownVisualBlocks(input), "Before\n\n\n\nAfter");
  strictEqual(
    stripRichMarkdownVisualBlocks('Before\n\n<media-plot x="-5'),
    "Before\n\n",
  );

  const rendered: string[] = [];
  const output = await insertHtmlVisuals(input, async (html) => {
    rendered.push(html);
    return "![](tg://photo?id=plot)";
  });
  strictEqual(
    output,
    "Before\n\n*Visual unavailable.*\n\n![](tg://photo?id=plot)\n\nAfter",
  );
  deepStrictEqual(rendered, [plot]);
});

test("new media tags pass their source to the same image group", async () => {
  const graphics = [
    "<media-mermaid>flowchart TD\nA --> B</media-mermaid>",
    '<media-intervals unit="s">Request | 1 | 4</media-intervals>',
    '<media-stacked-bars unit="s">Model | Tools | Render\nFast | 5 | 2</media-stacked-bars>',
    "<media-timebands>Build | 2026-05-04 | 2026-05-11</media-timebands>",
  ];
  const markdown = graphics.join("\n\n");
  const output = await insertHtmlVisuals(markdown, async (html) => {
    strictEqual(html, graphics.join("\n"));
    const expanded = expandMediaCharts(html);
    strictEqual(expanded.match(/<svg /g)?.length, 3);
    ok(expanded.includes("1–4 s"));
    ok(expanded.includes("7 s"));
    ok(expanded.includes("May 4"));
    ok(expanded.includes(graphics[0]));
    return "![](tg://photo?id=combined)";
  });
  strictEqual(output, "![](tg://photo?id=combined)");
});

test("invalid chart data produces a warning and leaves other charts usable", () => {
  const html = expandMediaCharts(
    [
      "<media-intervals>Reversed | 4 | 1</media-intervals>",
      "<media-timebands>Invalid | 2026-02-30 | 2026-03-10</media-timebands>",
      "<media-intervals>A & B | -2 | 2</media-intervals>",
    ].join("\n"),
  );
  strictEqual(html.match(/Chart unavailable/g)?.length, 2);
  ok(html.includes("A &amp; B"));
  strictEqual(html.match(/<svg /g)?.length, 1);
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

test("the visual kit serves only its bundled fonts", async () => {
  const kit = await getHtmlVisualKit();
  const urls = [
    ...kit.css.matchAll(/url\((\/__visual-kit\/fonts\/[^)]+)\)/g),
  ].map(([, url]) => url);

  ok(kit.css.includes(".v-bars"));
  ok(!kit.css.includes("font-display: swap"));
  ok(urls.length > 0);
  for (const url of urls) {
    const name = url.slice(HTML_VISUAL_KIT_FONT_PATH.length);
    const path = kit.fonts.get(name) ?? "";
    ok(path.endsWith(`/files/${name}`), url);
    ok(await Bun.file(path).exists(), path);
  }
  strictEqual(kit.fonts.size, new Set(urls).size);
});
