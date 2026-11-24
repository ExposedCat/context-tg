import { test } from "bun:test";
import { match, ok, strictEqual, throws } from "node:assert";
import { renderPlot } from "./html-plot-engine.ts";
import { expandHtmlPlots } from "./html-plots.ts";

const segments = (svg: string, kind: string) =>
  (new RegExp(`class="${kind}" d="([^"]*)"`).exec(svg)?.[1] ?? "").split("M")
    .length - 1;

test("a two-parameter plot draws every mesh line through a point-valued function", () => {
  const svg = renderPlot({
    attributes: "equal",
    body: [
      '"sheet": w(u, v) for u in 0..1.5 by 0.025, v in -1..1 by 0.025',
      "# Definitions may follow the plots that use them.",
      "w(u, v) = (u * (1 - k * v^2), v * (1 - 0.5 u))",
      "k = 0.35",
    ].join("\n"),
  });

  strictEqual(segments(svg, "line mesh"), 61 + 81);
  match(svg, /<g class="c1">/);
  match(svg, /<div class="v-legend"><span class="c1">sheet<\/span><\/div>/);
});

test("function graphs break at asymptotes instead of drawing vertical jumps", () => {
  const svg = renderPlot({
    attributes: 'x="-1..1" y="-5..5"',
    body: "y = 1 / x",
  });
  strictEqual(segments(svg, "line"), 2);
});

test("parametric curves, points, and calculator-style constants share one scope", () => {
  const svg = renderPlot({
    attributes: 'x="-2..2" y="-2..2"',
    body: [
      "r = 1.5",
      "(r cos(t), r sin(t)) for t in 0..2pi",
      '"P": (r, 0)',
    ].join("\n"),
  });
  strictEqual(segments(svg, "line"), 1);
  match(svg, /<circle class="dot"/);
  match(svg, />P<\/text>/);
});

test("plot expressions cannot reach evaluation or large allocations", () => {
  for (const body of [
    'y = evaluate("1")',
    "y = sum(zeros(1e5))",
    "y = sum(1:1e9)",
    "y = import({})",
  ]) {
    throws(() => renderPlot({ attributes: "", body }), /not available/);
  }
});

test("visuals keep their markup while failed plots become warning notes", async () => {
  const html = await expandHtmlPlots(
    [
      "<html><div class='v-card'>",
      "<tg-plot>y = x &lt; 0 ? -x : x^2</tg-plot>",
      "<tg-plot>y = missing(x)</tg-plot>",
      "</div></html>",
    ].join(""),
  );

  match(html, /^<html><div class='v-card'><figure class="v-plot"><svg/);
  match(html, /clip-path="url\(#plot-0\)"/);
  match(
    html,
    /<aside class="v-note is-warn"><b>Plot unavailable<\/b>Cannot evaluate the plot: Undefined function missing<\/aside><\/div><\/html>$/,
  );
});

test("slow plots time out without blocking the bot", async () => {
  const started = performance.now();
  const html = await expandHtmlPlots(
    "<html><tg-plot>f(n) = n < 1 ? 0 : f(n - 1) + f(n - 1)\ny = f(40)</tg-plot></html>",
    undefined,
    200,
  );
  ok(performance.now() - started < 2_000);
  match(html, /The plot took too long/);
});
