import { escapeHtml } from "../utils/text.ts";

const CHART =
  /<media-(intervals|stacked-bars|timebands)(?=[\s>])((?:"[^"]*"|'[^']*'|[^'"<>])*)>([\s\S]*?)<\/media-\1\s*>/gi;
const DAY_MS = 86_400_000;
const MAX_ROWS = 12;
const PLOT_LEFT = 182;
const PLOT_RIGHT = 552;
const ROW_HEIGHT = 42;
const numberFormat = new Intl.NumberFormat("en", {
  maximumSignificantDigits: 5,
});
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function expandMediaCharts(html: string): string {
  return html.replace(
    CHART,
    (_, kind: string, attributes: string, body: string) => {
      try {
        const chart = kind.toLowerCase();
        const unitMatch = /\bunit\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(
          attributes,
        );
        const unit = shortLabel(
          (unitMatch?.[1] ?? unitMatch?.[2] ?? "").trim(),
          8,
        );
        const rows = body
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => line.split("|").map((value) => value.trim()));
        if (
          !rows.length ||
          rows.length > MAX_ROWS + Number(chart === "stacked-bars")
        ) {
          throw new Error(`Use between 1 and ${MAX_ROWS} data rows.`);
        }
        return chart === "stacked-bars"
          ? stackedBars(rows, unit)
          : intervals(rows, unit, chart === "timebands");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Check the chart data.";
        return `<aside class="v-note is-warn"><b>Chart unavailable</b>${escapeHtml(message)}</aside>`;
      }
    },
  );
}

function shortLabel(label: string, maxLength: number): string {
  const characters = Array.from(label);
  return characters.length <= maxLength
    ? label
    : `${characters.slice(0, maxLength - 1).join("")}…`;
}

function numeric(value: string): number {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || Math.abs(n) > 1e12) {
    throw new Error(
      "Use finite numbers with a magnitude of at most one trillion.",
    );
  }
  return n;
}

function formatNumber(value: number): string {
  const magnitude = Math.abs(value);
  return (magnitude > 0 && magnitude < 0.001) || magnitude >= 1e6
    ? value.toExponential(2)
    : numberFormat.format(value);
}

function calendarDay(value: string): number {
  const ms = Date.parse(value);
  if (
    !/^\d{4}-\d\d-\d\d$/.test(value) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Use valid dates in YYYY-MM-DD format.");
  }
  return ms / DAY_MS;
}

function label(x: number, y: number, value: string): string {
  return `<text class="lbl" x="${x}" y="${y}" dominant-baseline="middle">${escapeHtml(value)}</text>`;
}

function chartScale(min: number, max: number, dates = false) {
  const span = max - min || (dates ? 1 : Math.max(1, Math.abs(min) / 10));
  const approximateStep = span / 4 || span;
  const magnitude = 10 ** Math.floor(Math.log10(approximateStep));
  const step = dates
    ? span >= 14
      ? Math.ceil(approximateStep / 7) * 7
      : Math.ceil(approximateStep)
    : ([1, 2, 2.5, 3, 4, 5, 10].find((n) => n * magnitude >= approximateStep) ??
        10) * magnitude;
  const origin = dates && span >= 14 ? -3 : 0; // Monday before the Unix epoch.
  const first = Math.floor((min - origin) / step);
  const last = Math.ceil((min + span - origin) / step);
  const ticks =
    Number.isSafeInteger(first) &&
    Number.isSafeInteger(last) &&
    last > first &&
    last - first <= 6
      ? Array.from(
          { length: last - first + 1 },
          (_, i) => origin + (first + i) * step,
        )
      : [min, min + span];
  const domain: [number, number] = [
    Math.min(ticks[0], min),
    Math.max(ticks.at(-1) ?? max, min + span),
  ];
  return { domain, ticks };
}

function horizontalChart(
  name: string,
  labels: string[],
  domain: [number, number],
  ticks: number[],
  format: (value: number) => string,
  marks: (index: number, y: number, x: (value: number) => number) => string,
): string {
  const [min, max] = domain;
  const x = (value: number) =>
    PLOT_LEFT + ((value - min) / (max - min)) * (PLOT_RIGHT - PLOT_LEFT);
  const bottom = labels.length * ROW_HEIGHT + 6;
  const grid = ticks
    .map((tick) => {
      const p = x(tick);
      return `<line class="grid" x1="${p}" y1="4" x2="${p}" y2="${bottom}"/><text class="tick" x="${p}" y="${bottom + 20}" text-anchor="middle">${escapeHtml(format(tick))}</text>`;
    })
    .join("");
  const series = labels
    .map((name, index) => {
      const y = 24 + index * ROW_HEIGHT;
      const limit =
        /[\p{Script=Han}\p{Script=Hangul}\p{Script=Katakana}\p{Script=Hiragana}]/u.test(
          name,
        )
          ? 11
          : 21;
      return `<g><title>${escapeHtml(name)}</title>${label(1, y, shortLabel(name, limit))}${marks(index, y, x)}</g>`;
    })
    .join("");
  return `<svg class="v-chart" viewBox="0 0 648 ${bottom + 29}" role="img" aria-label="${name}">${grid}<line class="base" x1="${PLOT_LEFT}" y1="${bottom}" x2="${PLOT_RIGHT}" y2="${bottom}"/>${series}</svg>`;
}

function intervals(rows: string[][], unit: string, dates: boolean): string {
  const parse = dates ? calendarDay : numeric;
  const series = rows.map((row) => {
    const [name, low, high] = row;
    if (row.length !== 3 || !name)
      throw new Error("Use one label, start, and end per row.");
    const start = parse(low);
    const end = parse(high);
    if (start > end)
      throw new Error("Each start must be at or before its end.");
    return { name, start, end };
  });
  const min = Math.min(...series.map(({ start }) => start));
  const max = Math.max(...series.map(({ end }) => end));
  const { domain, ticks } = chartScale(min, max, dates);
  const display = (value: number) =>
    dates ? dateFormat.format(value * DAY_MS) : formatNumber(value);
  return horizontalChart(
    dates ? "Timebands" : "Intervals",
    series.map(({ name }) => name),
    domain,
    ticks,
    display,
    (index, y, x) => {
      const { start, end } = series[index];
      const range = dates
        ? dateFormat.formatRange(start * DAY_MS, end * DAY_MS)
        : `${display(start)}–${display(end)}${unit ? ` ${unit}` : ""}`;
      const length = x(end) - x(start);
      const band = dates
        ? `<rect x="${x(start)}" y="${y - 6}" width="${Math.max(2, length)}" height="12" rx="2" fill="var(--c)"/>`
        : `<line class="line" x1="${x(start)}" y1="${y}" x2="${x(end)}" y2="${y}"/><circle class="dot" cx="${x(start)}" cy="${y}" r="4"/><circle class="dot" cx="${x(end)}" cy="${y}" r="4"/>`;
      return `<g class="${index === series.length - 1 ? "c1" : "c0"}"><title>${escapeHtml(range)}</title>${band}${label(PLOT_RIGHT + 12, y, shortLabel(range, 12))}</g>`;
    },
  );
}

function stackedBars(rows: string[][], unit: string): string {
  const [header, ...data] = rows;
  const series = header.slice(1);
  if (
    !header[0] ||
    series.length < 2 ||
    series.length > 5 ||
    series.some((name) => !name) ||
    !data.length
  ) {
    throw new Error(
      "Use a header with 2 to 5 series, followed by at least one data row.",
    );
  }
  const stack = data.map(([name, ...values]) => {
    if (!name || values.length !== series.length)
      throw new Error("Give each row one value per series.");
    const valuesAsNumbers = values.map(numeric);
    if (valuesAsNumbers.some((value) => value < 0))
      throw new Error("Stacked values must be nonnegative.");
    return {
      name,
      values: valuesAsNumbers,
      total: valuesAsNumbers.reduce((sum, value) => sum + value, 0),
    };
  });
  const { domain, ticks } = chartScale(
    0,
    Math.max(...stack.map(({ total }) => total)),
  );
  const svg = horizontalChart(
    "Stacked bars",
    stack.map(({ name }) => name),
    domain,
    ticks,
    formatNumber,
    (index, y, x) => {
      let from = 0;
      const { values, total } = stack[index];
      const bars = values
        .map((value, i) => {
          const start = x(from);
          from += value;
          const width = x(from) - start;
          return width > 0
            ? `<rect class="c${i + 1}" x="${start}" y="${y - 8}" width="${Math.max(0.5, width - 1)}" height="16" fill="var(--c)"><title>${escapeHtml(`${series[i]} ${formatNumber(value)} ${unit}`.trim())}</title></rect>`
            : "";
        })
        .join("");
      return (
        bars +
        label(
          x(total) + 9,
          y,
          shortLabel(`${formatNumber(total)} ${unit}`.trim(), 12),
        )
      );
    },
  );
  const legend = series
    .map((name, i) => `<span class="c${i + 1}">${escapeHtml(name)}</span>`)
    .join("");
  return `<figure>${svg}<figcaption class="v-legend">${legend}</figcaption></figure>`;
}
