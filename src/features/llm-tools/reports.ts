import type { FunctionToolRunner } from "./types.ts";

type ReportScore = {
  label: string;
  value: string;
  note: string;
};

type ReportSubsection = {
  title: string;
  content: string;
  bullets: string[];
  score: ReportScore;
};

type ReportSection = {
  title: string;
  content: string;
  bullets: string[];
  score: ReportScore;
  subsections: ReportSubsection[];
};

type ReportSource = {
  title: string;
  url: string;
};

type ReportCompanyInfo = {
  uniqueness: string;
  capitalization: string;
  revenue: string;
  annualRevenueGrowth: string;
  peRatio: string;
  forwardPeRatio: string;
  grossMargin: string;
};

export type LlmReport = {
  documentHtml: string;
  filename: string;
};

type StructuredReport = {
  title: string;
  filename: string;
  companyInfo: ReportCompanyInfo;
  sections: ReportSection[];
  sources: ReportSource[];
};

const emptyScoreDescription =
  "Use empty strings for label, value, and note when this block has no score.";

const scoreSchema = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description: "Short score label, for example State Score.",
    },
    value: {
      type: "string",
      description: "Score value or rating.",
    },
    note: {
      type: "string",
      description: "One short sentence explaining the score.",
    },
  },
  required: ["label", "value", "note"],
  additionalProperties: false,
} as const;

const subsectionSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Subsection heading.",
    },
    content: {
      type: "string",
      description:
        "Subsection narrative. Use blank lines between paragraphs when useful.",
    },
    bullets: {
      type: "array",
      description: "Important points for this subsection. Use [] if none.",
      items: { type: "string" },
    },
    score: {
      ...scoreSchema,
      description: emptyScoreDescription,
    },
  },
  required: ["title", "content", "bullets", "score"],
  additionalProperties: false,
} as const;

export const toolDefinition = {
  type: "function",
  name: "send_report",
  description:
    "Attach a long research report. Use this only for long research purposes when the report is too large or rich for a normal chat reply. Send structured JSON sections only; the app will turn them into a polished predefined HTML document. After using this tool, the normal assistant response must be a 2-3 sentence TL;DR of the report's conclusion, strongest evidence, and most important caveat; do not respond with only a generic attachment notice.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Human-readable report title.",
      },
      filename: {
        type: "string",
        description:
          "A short filename for the report. The bot will normalize it and ensure it uses the .html extension.",
      },
      company_info: {
        type: "object",
        description:
          "Company metrics for company or ticker reports. Use empty strings for every field when the report is not about a company.",
        properties: {
          uniqueness: {
            type: "string",
            description:
              "What makes the company differentiated, if anything. Mention if there is no clear uniqueness.",
          },
          capitalization: {
            type: "string",
            description:
              "Market capitalization or relevant capitalization context.",
          },
          revenue: {
            type: "string",
            description: "Most relevant recent revenue figure.",
          },
          annual_revenue_growth: {
            type: "string",
            description:
              "Annual revenue growth, including period/year when known.",
          },
          pe_ratio: {
            type: "string",
            description: "Trailing P/E ratio or N/A with a short reason.",
          },
          forward_pe_ratio: {
            type: "string",
            description: "Forward P/E ratio or N/A with a short reason.",
          },
          gross_margin: {
            type: "string",
            description: "Gross margin, including period/year when known.",
          },
        },
        required: [
          "uniqueness",
          "capitalization",
          "revenue",
          "annual_revenue_growth",
          "pe_ratio",
          "forward_pe_ratio",
          "gross_margin",
        ],
        additionalProperties: false,
      },
      sections: {
        type: "array",
        description:
          "Ordered report sections. Put all report content here as structured JSON, not HTML.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Main section heading.",
            },
            content: {
              type: "string",
              description:
                "Section narrative. Use blank lines between paragraphs when useful.",
            },
            bullets: {
              type: "array",
              description: "Important points for this section. Use [] if none.",
              items: { type: "string" },
            },
            score: {
              ...scoreSchema,
              description: emptyScoreDescription,
            },
            subsections: {
              type: "array",
              description: "Ordered subsections. Use [] if none.",
              items: subsectionSchema,
            },
          },
          required: ["title", "content", "bullets", "score", "subsections"],
          additionalProperties: false,
        },
      },
      sources: {
        type: "array",
        description:
          "Source links used in the report. Use [] if sources are already covered by chat citations or no source links are needed.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Source label or title.",
            },
            url: {
              type: "string",
              description: "Source URL.",
            },
          },
          required: ["title", "url"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "filename", "company_info", "sections", "sources"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function normalizeReportFilename(value: unknown): string {
  const rawFilename = typeof value === "string" ? value.trim() : "";
  const safeFilename = rawFilename
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/[^a-z0-9._ -]/gi, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const filename = safeFilename || "research-report.html";

  return /\.html?$/i.test(filename) ? filename : `${filename}.html`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((item) => item.length > 0)
    : [];
}

function parseScore(value: unknown): ReportScore {
  const score = asRecord(value);

  return {
    label: asString(score?.label),
    value: asString(score?.value),
    note: asString(score?.note),
  };
}

function parseSubsection(value: unknown): ReportSubsection | undefined {
  const subsection = asRecord(value);

  if (!subsection) {
    return undefined;
  }

  return {
    title: asString(subsection.title),
    content: asString(subsection.content),
    bullets: asStringArray(subsection.bullets),
    score: parseScore(subsection.score),
  };
}

function parseSection(value: unknown): ReportSection | undefined {
  const section = asRecord(value);

  if (!section) {
    return undefined;
  }

  return {
    title: asString(section.title),
    content: asString(section.content),
    bullets: asStringArray(section.bullets),
    score: parseScore(section.score),
    subsections: Array.isArray(section.subsections)
      ? section.subsections.flatMap((item) => {
          const parsed = parseSubsection(item);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

function parseSource(value: unknown): ReportSource | undefined {
  const source = asRecord(value);
  const url = asString(source?.url);

  if (!source || !url) {
    return undefined;
  }

  return {
    title: asString(source.title) || url,
    url,
  };
}

function parseCompanyInfo(value: unknown): ReportCompanyInfo {
  const companyInfo = asRecord(value);

  return {
    uniqueness: asString(companyInfo?.uniqueness),
    capitalization: asString(companyInfo?.capitalization),
    revenue: asString(companyInfo?.revenue),
    annualRevenueGrowth: asString(companyInfo?.annual_revenue_growth),
    peRatio: asString(companyInfo?.pe_ratio),
    forwardPeRatio: asString(companyInfo?.forward_pe_ratio),
    grossMargin: asString(companyInfo?.gross_margin),
  };
}

function parseReport(args: Record<string, unknown> | null): StructuredReport {
  return {
    title: asString(args?.title) || "Report",
    filename: normalizeReportFilename(args?.filename),
    companyInfo: parseCompanyInfo(args?.company_info),
    sections: Array.isArray(args?.sections)
      ? args.sections.flatMap((item) => {
          const parsed = parseSection(item);
          return parsed?.title ? [parsed] : [];
        })
      : [],
    sources: Array.isArray(args?.sources)
      ? args.sources.flatMap((item) => {
          const parsed = parseSource(item);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function renderParagraphs(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphs
    .map(
      (paragraph) =>
        `<p>${paragraph.split(/\n/).map(escapeHtml).join("<br>")}</p>`,
    )
    .join("\n");
}

function renderBullets(bullets: string[]): string {
  if (bullets.length === 0) {
    return "";
  }

  return `<ul>
${bullets.map((bullet) => `        <li>${escapeHtml(bullet)}</li>`).join("\n")}
      </ul>`;
}

function getScoreClass(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "great":
    case "good":
    case "positive":
    case "buy":
      return "score-positive";
    case "poor":
    case "bad":
    case "negative":
    case "avoid":
      return "score-negative";
    case "mediocre":
    case "neutral":
    case "mixed":
    case "wait":
      return "score-neutral";
    default:
      return "";
  }
}

function renderScore(score: ReportScore): string {
  if (!score.label && !score.value && !score.note) {
    return "";
  }

  const value = score.value || "Unscored";

  return `<div class="score ${getScoreClass(value)}">
        <div>
          <span class="score-label">${escapeHtml(score.label || "Score")}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
        ${score.note ? `<p>${escapeHtml(score.note)}</p>` : ""}
      </div>`;
}

function renderSubsection(subsection: ReportSubsection): string {
  return `<section class="subsection">
      <h3>${escapeHtml(subsection.title)}</h3>
      ${renderParagraphs(subsection.content)}
      ${renderBullets(subsection.bullets)}
      ${renderScore(subsection.score)}
    </section>`;
}

function renderSection(section: ReportSection, index: number): string {
  return `<section class="report-section">
    <div class="section-kicker">${String(index + 1).padStart(2, "0")}</div>
    <h2>${escapeHtml(section.title)}</h2>
    ${renderParagraphs(section.content)}
    ${renderBullets(section.bullets)}
    ${renderScore(section.score)}
    ${section.subsections.map(renderSubsection).join("\n")}
  </section>`;
}

function hasCompanyInfo(companyInfo: ReportCompanyInfo): boolean {
  return Object.values(companyInfo).some((value) => value.length > 0);
}

function renderCompanyMetric(label: string, value: string): string {
  if (!value) {
    return "";
  }

  return `<div class="company-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>`;
}

function renderCompanyInfo(companyInfo: ReportCompanyInfo): string {
  if (!hasCompanyInfo(companyInfo)) {
    return "";
  }

  return `<section class="company-info">
    <div class="company-info-heading">
      <span class="report-label">Company Info</span>
      <p>${escapeHtml(companyInfo.uniqueness || "No clear uniqueness found.")}</p>
    </div>
    <div class="company-metrics">
      ${renderCompanyMetric("Capitalization", companyInfo.capitalization)}
      ${renderCompanyMetric("Revenue", companyInfo.revenue)}
      ${renderCompanyMetric(
        "Annual Revenue Growth",
        companyInfo.annualRevenueGrowth,
      )}
      ${renderCompanyMetric("P/E", companyInfo.peRatio)}
      ${renderCompanyMetric("Forward P/E", companyInfo.forwardPeRatio)}
      ${renderCompanyMetric("Gross Margin", companyInfo.grossMargin)}
    </div>
  </section>`;
}

function renderSources(sources: ReportSource[]): string {
  if (sources.length === 0) {
    return "";
  }

  return `<section class="sources">
    <h2>Sources</h2>
    <ol>
${sources
  .map(
    (source) =>
      `      <li><a href="${escapeHtmlAttribute(source.url)}">${escapeHtml(
        source.title,
      )}</a></li>`,
  )
  .join("\n")}
    </ol>
  </section>`;
}

function renderReportDocument(report: StructuredReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #192025;
      --muted: #65717b;
      --line: #d9e0e3;
      --paper: #fbfcfa;
      --panel: #ffffff;
      --accent: #126a72;
      --accent-soft: #e4f2f2;
      --positive: #177245;
      --positive-soft: #e6f3ec;
      --neutral: #8a6418;
      --neutral-soft: #f7efd9;
      --negative: #a83b35;
      --negative-soft: #f8e6e4;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.58;
    }

    main {
      width: min(920px, calc(100% - 32px));
      margin: 0 auto;
      padding: 44px 0 56px;
    }

    header {
      border-bottom: 2px solid var(--ink);
      margin-bottom: 28px;
      padding-bottom: 22px;
    }

    h1,
    h2,
    h3,
    p {
      margin: 0;
    }

    h1 {
      max-width: 760px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(2rem, 5vw, 4.25rem);
      font-weight: 700;
      letter-spacing: 0;
      line-height: 1;
    }

    .report-label,
    .section-kicker,
    .score-label {
      color: var(--accent);
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .report-label {
      display: inline-block;
      margin-bottom: 18px;
    }

    .report-section,
    .sources {
      padding: 26px 0;
      border-bottom: 1px solid var(--line);
    }

    .company-info {
      margin-bottom: 10px;
      padding: 20px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-top: 5px solid var(--accent);
      border-radius: 8px;
      box-shadow: 0 14px 36px rgb(25 32 37 / 8%);
    }

    .company-info-heading {
      display: grid;
      grid-template-columns: minmax(120px, 0.28fr) 1fr;
      gap: 18px;
      align-items: start;
    }

    .company-info-heading .report-label {
      margin-bottom: 0;
    }

    .company-info-heading p {
      margin-top: 0;
      font-size: 1.02rem;
    }

    .company-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      margin-top: 18px;
      overflow: hidden;
      background: var(--line);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .company-metric {
      min-width: 0;
      padding: 14px;
      background: #f7faf8;
    }

    .company-metric span {
      display: block;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .company-metric strong {
      display: block;
      margin-top: 6px;
      overflow-wrap: anywhere;
      font-size: 1rem;
      line-height: 1.25;
    }

    h2 {
      margin-top: 6px;
      font-size: 1.7rem;
      line-height: 1.15;
    }

    h3 {
      margin-bottom: 8px;
      font-size: 1.05rem;
      line-height: 1.25;
    }

    p {
      margin-top: 12px;
      color: #273138;
    }

    ul,
    ol {
      margin: 14px 0 0;
      padding-left: 1.35rem;
    }

    li + li {
      margin-top: 8px;
    }

    a {
      color: var(--accent);
    }

    .subsection {
      margin-top: 18px;
      padding: 18px 18px 16px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .score {
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-top: 16px;
      padding: 14px 16px;
      background: var(--accent-soft);
      border-left: 4px solid var(--accent);
      border-radius: 8px;
    }

    .score strong {
      display: block;
      margin-top: 2px;
      font-size: 1.05rem;
    }

    .score p {
      max-width: 560px;
      margin-top: 0;
      color: var(--muted);
    }

    .score-positive {
      background: var(--positive-soft);
      border-left-color: var(--positive);
    }

    .score-positive .score-label {
      color: var(--positive);
    }

    .score-neutral {
      background: var(--neutral-soft);
      border-left-color: var(--neutral);
    }

    .score-neutral .score-label {
      color: var(--neutral);
    }

    .score-negative {
      background: var(--negative-soft);
      border-left-color: var(--negative);
    }

    .score-negative .score-label {
      color: var(--negative);
    }

    @media (max-width: 640px) {
      main {
        width: min(100% - 22px, 920px);
        padding-top: 28px;
      }

      .score {
        display: block;
      }

      .score p {
        margin-top: 8px;
      }

      .company-info-heading {
        display: block;
      }

      .company-info-heading p {
        margin-top: 10px;
      }

      .company-metrics {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <span class="report-label">Report</span>
      <h1>${escapeHtml(report.title)}</h1>
    </header>
    ${renderCompanyInfo(report.companyInfo)}
    ${report.sections.map(renderSection).join("\n")}
    ${renderSources(report.sources)}
  </main>
</body>
</html>`;
}

export const execute: FunctionToolRunner = (args) => {
  const report = parseReport(args);

  if (report.sections.length === 0) {
    return JSON.stringify({
      error: "sections must include at least one item.",
    });
  }

  return {
    output:
      "Report accepted. Final response must be a 2-3 sentence TL;DR of the report's conclusion, strongest evidence, and most important caveat; do not respond with only a generic attachment notice.",
    report: {
      documentHtml: renderReportDocument(report),
      filename: report.filename,
    },
  };
};
