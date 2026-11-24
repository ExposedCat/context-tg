import { all, create, type EvalFunction, isMatrix } from "mathjs";

/**
 * Renders `<tg-plot>` bodies to kit-styled SVG. Runs only inside the bounded
 * plot worker because user expressions can be arbitrarily expensive.
 */

const math = create(all);
const parse = math.parse;
// Expressions come from the model. Block functions that evaluate nested code,
// mutate the math instance, or allocate large matrices in one call.
const DISABLED = [
  "import",
  "createUnit",
  "evaluate",
  "parse",
  "compile",
  "simplify",
  "derivative",
  "resolve",
  "reviver",
  "range",
  "zeros",
  "ones",
  "identity",
  "resize",
  "concat",
  "diag",
  "kron",
  "matrixFromFunction",
  "matrixFromRows",
  "matrixFromColumns",
];
math.import(
  Object.fromEntries(
    DISABLED.map((name) => [
      name,
      () => {
        throw new Error(`${name} is not available in plots.`);
      },
    ]),
  ),
  { override: true },
);

const WIDTH = 648;
const MIN_WIDTH = 200;
const DEFAULT_HEIGHT = 360;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 900;
const PAD = { top: 10, right: 12, bottom: 24, left: 44 };
const GRAPH_SAMPLES = 800;
const CURVE_SAMPLES = 720;
const MAX_CURVE_SAMPLES = 5_000;
const MESH_STEPS = 20;
const MESH_LINE_SAMPLES = 160;
const MAX_MESH_LINES = 200;
const MAX_POINTS = 120_000;
const MAX_STATEMENTS = 40;
const SERIES = 5;

export class PlotError extends Error {}

type Point = [number, number];
type Param = { name: string; from: number; to: number; step?: number };
type Mark =
  | { kind: "graph"; label?: string; expr: EvalFunction }
  | { kind: "curve"; label?: string; expr: EvalFunction; params: Param[] }
  | { kind: "point"; label?: string; expr: EvalFunction };
type Series = { mark: Mark; color: number; lines: Point[][] };
type Range = [number, number];

export type PlotInput = { attributes: string; body: string };

export function renderPlot(
  { attributes, body }: PlotInput,
  id = "plot",
): string {
  const scope = new Map<string, unknown>();
  const attrs = parseAttributes(attributes);
  const marks = parseStatements(decodeEntities(body), scope);
  if (!marks.length) throw new PlotError("The plot has nothing to draw.");

  const height = clamp(
    Math.round(Number(attrs.get("height") ?? DEFAULT_HEIGHT)) || DEFAULT_HEIGHT,
    MIN_HEIGHT,
    MAX_HEIGHT,
  );
  const xAttr = attrs.has("x")
    ? parseRange(attrs.get("x") ?? "", scope)
    : undefined;
  const yAttr = attrs.has("y")
    ? parseRange(attrs.get("y") ?? "", scope)
    : undefined;
  const graphX: Range = xAttr ?? [-10, 10];

  let budget = MAX_POINTS;
  const take = (count: number) => {
    budget -= count;
    if (budget < 0) throw new PlotError("The plot needs too many points.");
  };
  let color = 0;
  const series: Series[] = marks.map((mark) => {
    const lines =
      mark.kind === "graph"
        ? sampleGraph(mark.expr, scope, graphX, take)
        : mark.kind === "point"
          ? [[toPoint(mark.expr.evaluate(scope))]]
          : sampleCurve(mark.expr, mark.params, scope, take);
    return { mark, color: color++ % SERIES, lines };
  });

  const width = clamp(
    Math.round(Number(attrs.get("width") ?? WIDTH)) || WIDTH,
    MIN_WIDTH,
    WIDTH,
  );
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  let x = xAttr ?? autoRange(series, 0, false) ?? graphX;
  let y = yAttr ?? autoRange(series, 1, true) ?? [-1, 1];
  if (attrs.has("equal")) [x, y] = equalize(x, y, plotW, plotH);

  return draw(series, x, y, width, height, plotW, plotH, id);
}

/* ── Parsing ─────────────────────────────────────────────────────────── */

function parseAttributes(source: string) {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(
    /([a-z]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi,
  )) {
    attrs.set(
      match[1]?.toLowerCase() ?? "",
      decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""),
    );
  }
  return attrs;
}

function decodeEntities(text: string) {
  return text.replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (_, name: string) => {
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "#39":
        return "'";
      case "nbsp":
        return " ";
      default:
        return "&";
    }
  });
}

function parseStatements(body: string, scope: Map<string, unknown>): Mark[] {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean);
  if (lines.length > MAX_STATEMENTS) {
    throw new PlotError(`Use at most ${MAX_STATEMENTS} plot lines.`);
  }

  const definitions: string[] = [];
  const plots: (() => Mark)[] = [];
  for (const line of lines) {
    const labelled = /^"([^"]{1,60})"\s*:\s*(.+)$/.exec(line);
    const label = labelled?.[1];
    const statement = labelled?.[2] ?? line;
    const loop = /^(.+?)\s+for\s+(.+)$/.exec(statement);
    const graph = /^y\s*=\s*(.+)$/.exec(statement);

    if (loop) {
      const [, source = "", spec = ""] = loop;
      plots.push(() => {
        const params = splitTopLevel(spec).map((part) =>
          parseParam(part, scope),
        );
        const names = new Set(params.map((param) => param.name));
        if (names.size !== params.length || params.length > 2) {
          throw new PlotError("Use one or two distinct parameters after for.");
        }
        return {
          kind: "curve",
          label,
          expr: compile(tupleToMatrix(source)),
          params,
        };
      });
    } else if (graph) {
      const source = graph[1] ?? "";
      plots.push(() => ({ kind: "graph", label, expr: compile(source) }));
    } else if (isTuple(statement)) {
      plots.push(() => ({
        kind: "point",
        label,
        expr: compile(tupleToMatrix(statement)),
      }));
    } else if (/^[a-z_]\w*\s*(\([^)]*\))?\s*=[^=]/i.test(statement)) {
      definitions.push(statement);
    } else {
      throw new PlotError(`Cannot read plot line: ${statement}`);
    }
  }

  // As in graphing calculators, definitions may appear after the plots that
  // use them. Functions resolve names when called; constants run in order.
  for (const definition of definitions) {
    const [, name = "", rest = ""] =
      /^([a-z_]\w*\s*(?:\([^)]*\))?)\s*=(.+)$/i.exec(definition) ?? [];
    compile(`${name} = ${tupleToMatrix(rest)}`).evaluate(scope);
  }
  return plots.map((plot) => plot());
}

function compile(source: string): EvalFunction {
  try {
    return parse(source).compile();
  } catch (error) {
    throw new PlotError(
      `Cannot parse "${source}": ${error instanceof Error ? error.message : error}`,
    );
  }
}

function parseParam(source: string, scope: Map<string, unknown>): Param {
  const match =
    /^([a-z_]\w*)\s+in\s+(.+?)\s*\.\.\s*(.+?)(?:\s+by\s+(.+))?$/i.exec(source);
  if (!match) {
    throw new PlotError(`Write parameters as "t in 0..2pi": ${source}`);
  }
  const [from, to] = parseRange(`${match[2]}..${match[3]}`, scope);
  const step = match[4] ? number(compile(match[4]).evaluate(scope)) : undefined;
  if (step !== undefined && !(step > 0)) {
    throw new PlotError(`The step must be positive: ${source}`);
  }
  return { name: match[1] ?? "", from, to, step };
}

function parseRange(source: string, scope: Map<string, unknown>): Range {
  const [a = "", b = ""] = source.split("..");
  const range: Range = [
    number(compile(a).evaluate(scope)),
    number(compile(b).evaluate(scope)),
  ];
  if (!range.every(Number.isFinite) || range[0] >= range[1]) {
    throw new PlotError(`Invalid range: ${source}`);
  }
  return range;
}

function splitTopLevel(source: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function isTuple(source: string) {
  const text = source.trim();
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0 && i < text.length - 1) {
      return false;
    }
  }
  return splitTopLevel(text.slice(1, -1)).length === 2;
}

/** Calculator-style `(x, y)` points become math.js vectors. */
function tupleToMatrix(source: string) {
  const text = source.trim();
  return isTuple(text) ? `[${text.slice(1, -1)}]` : text;
}

/* ── Sampling ────────────────────────────────────────────────────────── */

function number(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function toPoint(value: unknown): Point {
  const array = isMatrix(value) ? value.toArray() : value;
  return Array.isArray(array) && array.length === 2
    ? [number(array[0]), number(array[1])]
    : [Number.NaN, Number.NaN];
}

function sampleGraph(
  expr: EvalFunction,
  scope: Map<string, unknown>,
  [from, to]: Range,
  take: (count: number) => void,
): Point[][] {
  take(GRAPH_SAMPLES + 1);
  const line: Point[] = [];
  for (let i = 0; i <= GRAPH_SAMPLES; i++) {
    const x = from + ((to - from) * i) / GRAPH_SAMPLES;
    scope.set("x", x);
    line.push([x, number(expr.evaluate(scope))]);
  }
  scope.delete("x");
  return [line];
}

function sampleCurve(
  expr: EvalFunction,
  params: Param[],
  scope: Map<string, unknown>,
  take: (count: number) => void,
): Point[][] {
  const at = (values: number[]) => {
    params.forEach((param, i) => {
      scope.set(param.name, values[i]);
    });
    return toPoint(expr.evaluate(scope));
  };
  const [p, q] = params;
  if (!p) return [];
  if (!q) {
    const count = p.step
      ? Math.min(Math.ceil((p.to - p.from) / p.step), MAX_CURVE_SAMPLES)
      : CURVE_SAMPLES;
    take(count + 1);
    const line = steps(p.from, p.to, count).map((t) => at([t]));
    scope.delete(p.name);
    return [line];
  }

  // A mesh draws lines of constant q along p, then lines of constant p.
  const gridP = gridValues(p);
  const gridQ = gridValues(q);
  const fineP = steps(p.from, p.to, MESH_LINE_SAMPLES);
  const fineQ = steps(q.from, q.to, MESH_LINE_SAMPLES);
  take((gridP.length + gridQ.length) * (MESH_LINE_SAMPLES + 1));
  const lines = [
    ...gridQ.map((b) => fineP.map((a) => at([a, b]))),
    ...gridP.map((a) => fineQ.map((b) => at([a, b]))),
  ];
  scope.delete(p.name);
  scope.delete(q.name);
  return lines;
}

function gridValues({ from, to, step }: Param) {
  const count = step ? Math.round((to - from) / step) : MESH_STEPS;
  if (count > MAX_MESH_LINES) {
    throw new PlotError(`Use at most ${MAX_MESH_LINES} mesh lines per side.`);
  }
  return steps(from, to, Math.max(count, 1));
}

function steps(from: number, to: number, count: number) {
  return Array.from(
    { length: count + 1 },
    (_, i) => from + ((to - from) * i) / count,
  );
}

/* ── Scales ──────────────────────────────────────────────────────────── */

function autoRange(
  series: Series[],
  axis: 0 | 1,
  trimOutliers: boolean,
): Range | undefined {
  const values = series
    .flatMap(({ mark, lines }) =>
      axis === 0 && mark.kind === "graph" ? [] : lines.flat(),
    )
    .map((point) => point[axis])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return undefined;
  // Asymptotes such as 1/x would otherwise flatten the rest of the graph.
  const cut = trimOutliers ? Math.floor(values.length * 0.02) : 0;
  let lo = values[cut] ?? 0;
  let hi = values[values.length - 1 - cut] ?? 0;
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

function equalize(x: Range, y: Range, w: number, h: number): [Range, Range] {
  const unit = Math.max((x[1] - x[0]) / w, (y[1] - y[0]) / h);
  const grow = ([lo, hi]: Range, size: number): Range => {
    const mid = (lo + hi) / 2;
    return [mid - (unit * size) / 2, mid + (unit * size) / 2];
  };
  return [grow(x, w), grow(y, h)];
}

function niceTicks([lo, hi]: Range, target: number) {
  const raw = (hi - lo) / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

function formatTick(value: number) {
  const text = Number(value.toPrecision(4)).toString();
  return text.replace(/^-/, "−");
}

/* ── Drawing ─────────────────────────────────────────────────────────── */

function draw(
  series: Series[],
  [x0, x1]: Range,
  [y0, y1]: Range,
  width: number,
  height: number,
  plotW: number,
  plotH: number,
  id: string,
) {
  const sx = (x: number) => PAD.left + ((x - x0) / (x1 - x0)) * plotW;
  const sy = (y: number) => PAD.top + ((y1 - y) / (y1 - y0)) * plotH;
  const px = (v: number) => clamp(v, -1e4, 1e4).toFixed(1);
  const bottom = PAD.top + plotH;
  const right = PAD.left + plotW;
  const out: string[] = [];

  for (const t of niceTicks([x0, x1], Math.max(3, Math.round(plotW / 75)))) {
    const x = px(sx(t));
    out.push(
      `<line class="${t === 0 ? "base" : "grid"}" x1="${x}" x2="${x}" y1="${PAD.top}" y2="${bottom}"/>`,
      `<text class="tick" x="${x}" y="${bottom + 16}" text-anchor="middle">${formatTick(t)}</text>`,
    );
  }
  for (const t of niceTicks([y0, y1], Math.max(3, Math.round(plotH / 60)))) {
    const y = px(sy(t));
    out.push(
      `<line class="${t === 0 ? "base" : "grid"}" x1="${PAD.left}" x2="${right}" y1="${y}" y2="${y}"/>`,
      `<text class="tick" x="${PAD.left - 8}" y="${y}" dy="0.32em" text-anchor="end">${formatTick(t)}</text>`,
    );
  }

  const spanY = y1 - y0;
  out.push(`<g clip-path="url(#${id})">`);
  for (const { mark, color, lines } of series) {
    out.push(`<g class="c${color + 1}">`);
    if (mark.kind === "point") {
      const [x, y] = lines[0]?.[0] ?? [Number.NaN, Number.NaN];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out.push(
          `<circle class="dot" cx="${px(sx(x))}" cy="${px(sy(y))}" r="4.5"/>`,
        );
      }
    } else {
      const d = lines
        .map((line) => pathData(line, sx, sy, px, y0 - spanY, y1 + spanY))
        .join("");
      const mesh = mark.kind === "curve" && mark.params.length === 2;
      if (d) out.push(`<path class="line${mesh ? " mesh" : ""}" d="${d}"/>`);
    }
    out.push("</g>");
  }
  out.push("</g>");

  // Point labels sit beside the dot; other series are named in the legend.
  for (const { mark, color, lines } of series) {
    const [x, y] = lines[0]?.[0] ?? [Number.NaN, Number.NaN];
    if (mark.kind === "point" && mark.label && Number.isFinite(x + y)) {
      out.push(
        `<text class="lbl c${color + 1}" x="${px(sx(x) + 9)}" y="${px(sy(y) - 7)}">${escapeHtml(mark.label)}</text>`,
      );
    }
  }

  const legend = series
    .filter(({ mark }) => mark.label && mark.kind !== "point")
    .map(
      ({ mark, color }) =>
        `<span class="c${color + 1}">${escapeHtml(mark.label ?? "")}</span>`,
    )
    .join("");
  return [
    `<figure class="v-plot">`,
    `<svg class="v-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Plot">`,
    `<defs><clipPath id="${id}"><rect x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}"/></clipPath></defs>`,
    ...out,
    "</svg>",
    legend ? `<div class="v-legend">${legend}</div>` : "",
    "</figure>",
  ].join("");
}

function pathData(
  line: Point[],
  sx: (x: number) => number,
  sy: (y: number) => number,
  px: (v: number) => string,
  yMin: number,
  yMax: number,
) {
  let d = "";
  let pen = false;
  let previous: Point | undefined;
  for (const point of line) {
    const [x, y] = point;
    const finite = Number.isFinite(x) && Number.isFinite(y);
    // Break at gaps and at jumps across the view, such as tan(x) asymptotes.
    const jump =
      previous &&
      ((previous[1] < yMin && y > yMax) || (previous[1] > yMax && y < yMin));
    if (!finite || jump) pen = false;
    if (finite) {
      d += `${pen ? "L" : "M"}${px(sx(x))} ${px(sy(y))}`;
      pen = true;
    }
    previous = finite ? point : undefined;
  }
  return d.includes("L") ? d : "";
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
