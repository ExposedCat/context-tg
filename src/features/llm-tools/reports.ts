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

type ReportCompanyData = {
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
  sections: ReportSection[];
  sources: ReportSource[];
};

type TradingSubsectionInput = {
  elaboration: string;
  bullets: string[];
};

type TradingScoreInput = {
  value: string;
  note: string;
};

type TradingReport = StructuredReport & {
  companyData: ReportCompanyData;
};

type RenderableReport = StructuredReport & {
  companyData?: ReportCompanyData;
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
    "Attach a long general research report. Use this only for broad research when the report is too large or rich for a normal chat reply. Send structured JSON sections only, without company data or HTML; the app will turn them into a polished predefined HTML document. After using this tool, the normal assistant response must be a 2-3 sentence TL;DR of the report's conclusion, strongest evidence, and most important caveat; do not respond with only a generic attachment notice.",
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
    required: ["title", "filename", "sections", "sources"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const companyDataSchema = {
  type: "object",
  description:
    "Company data shown at the top of the trading report. Use N/A plus a short reason when a metric is not meaningful or not found.",
  properties: {
    uniqueness: {
      type: "string",
      description:
        "What makes the company differentiated, if anything. Mention if there is no clear uniqueness.",
    },
    capitalization: {
      type: "string",
      description: "Market capitalization or relevant capitalization context.",
    },
    revenue: {
      type: "string",
      description: "Most relevant recent revenue figure.",
    },
    annual_revenue_growth: {
      type: "string",
      description: "Annual revenue growth, including period/year when known.",
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
} as const;

const tradingSubsectionSchema = {
  type: "object",
  properties: {
    elaboration: {
      type: "string",
      description:
        "Concrete evidence, dates, source type, interpretation, and confidence limits for this required subsection.",
    },
    bullets: {
      type: "array",
      description: "Important points for this subsection. Use [] if none.",
      items: { type: "string" },
    },
  },
  required: ["elaboration", "bullets"],
  additionalProperties: false,
} as const;

const tradingScoreSchema = {
  type: "object",
  properties: {
    value: {
      type: "string",
      enum: ["POOR", "MEDIOCRE", "GREAT"],
      description: "Required score value.",
    },
    note: {
      type: "string",
      description:
        "One short sentence explaining the score through the lens of entry quality right now.",
    },
  },
  required: ["value", "note"],
  additionalProperties: false,
} as const;

export const tradingToolDefinition = {
  type: "function",
  name: "send_trading_report",
  description:
    "Attach a trading research report with the exact required scorecard structure. Use this for company, ticker, stock, or trade-analysis research. Do not send generic sections or HTML; fill the fixed company news, market news, market state, company scope news, final view, company data, and sources fields. After using this tool, the normal assistant response must show each score value and summarize the resulting action in one useful sentence.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Human-readable trading report title.",
      },
      filename: {
        type: "string",
        description:
          "A short filename for the report. The bot will normalize it and ensure it uses the .html extension.",
      },
      company_data: companyDataSchema,
      company_news: {
        type: "object",
        properties: {
          company: tradingSubsectionSchema,
          reportings_and_earnings: tradingSubsectionSchema,
          praises_and_complaints: tradingSubsectionSchema,
          collaborations: tradingSubsectionSchema,
          misc: tradingSubsectionSchema,
          state_score: tradingScoreSchema,
        },
        required: [
          "company",
          "reportings_and_earnings",
          "praises_and_complaints",
          "collaborations",
          "misc",
          "state_score",
        ],
        additionalProperties: false,
      },
      market_news: {
        type: "object",
        properties: {
          events: tradingSubsectionSchema,
          talks_and_postings: tradingSubsectionSchema,
          misc: tradingSubsectionSchema,
          background_score: tradingScoreSchema,
        },
        required: ["events", "talks_and_postings", "misc", "background_score"],
        additionalProperties: false,
      },
      market_state: {
        type: "object",
        properties: {
          evaluation: tradingSubsectionSchema,
          sentiment: tradingSubsectionSchema,
          misc: tradingSubsectionSchema,
          market_score: tradingScoreSchema,
        },
        required: ["evaluation", "sentiment", "misc", "market_score"],
        additionalProperties: false,
      },
      company_scope_news: {
        type: "object",
        properties: {
          industry: tradingSubsectionSchema,
          sentiments: tradingSubsectionSchema,
          competitors: tradingSubsectionSchema,
          misc: tradingSubsectionSchema,
          industry_score: tradingScoreSchema,
        },
        required: [
          "industry",
          "sentiments",
          "competitors",
          "misc",
          "industry_score",
        ],
        additionalProperties: false,
      },
      final_view: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Concise actionable trade view with preferred action, time horizon, trigger or condition, strongest opposing argument, invalidation facts, and confidence.",
          },
          bullets: {
            type: "array",
            description: "Optional compact action points. Use [] if none.",
            items: { type: "string" },
          },
        },
        required: ["content", "bullets"],
        additionalProperties: false,
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
    required: [
      "title",
      "filename",
      "company_data",
      "company_news",
      "market_news",
      "market_state",
      "company_scope_news",
      "final_view",
      "sources",
    ],
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

function parseCompanyData(value: unknown): ReportCompanyData {
  const companyData = asRecord(value);

  return {
    uniqueness: asString(companyData?.uniqueness),
    capitalization: asString(companyData?.capitalization),
    revenue: asString(companyData?.revenue),
    annualRevenueGrowth: asString(companyData?.annual_revenue_growth),
    peRatio: asString(companyData?.pe_ratio),
    forwardPeRatio: asString(companyData?.forward_pe_ratio),
    grossMargin: asString(companyData?.gross_margin),
  };
}

function parseReport(args: Record<string, unknown> | null): StructuredReport {
  return {
    title: asString(args?.title) || "Report",
    filename: normalizeReportFilename(args?.filename),
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

function parseTradingSubsection(value: unknown): TradingSubsectionInput {
  const subsection = asRecord(value);

  return {
    elaboration: asString(subsection?.elaboration),
    bullets: asStringArray(subsection?.bullets),
  };
}

function parseTradingScore(value: unknown): TradingScoreInput {
  const score = asRecord(value);
  const scoreValue = asString(score?.value).toUpperCase();

  return {
    value: ["POOR", "MEDIOCRE", "GREAT"].includes(scoreValue) ? scoreValue : "",
    note: asString(score?.note),
  };
}

function buildTradingSubsection(
  title: string,
  subsection: TradingSubsectionInput,
): ReportSubsection {
  return {
    title,
    content: subsection.elaboration,
    bullets: subsection.bullets,
    score: { label: "", value: "", note: "" },
  };
}

function buildTradingScore(
  label: string,
  score: TradingScoreInput,
): ReportScore {
  return {
    label,
    value: score.value,
    note: score.note,
  };
}

function parseTradingReport(
  args: Record<string, unknown> | null,
): TradingReport {
  const companyNews = asRecord(args?.company_news);
  const marketNews = asRecord(args?.market_news);
  const marketState = asRecord(args?.market_state);
  const companyScopeNews = asRecord(args?.company_scope_news);
  const finalView = asRecord(args?.final_view);

  return {
    title: asString(args?.title) || "Trading Report",
    filename: normalizeReportFilename(args?.filename),
    companyData: parseCompanyData(args?.company_data),
    sections: [
      {
        title: "Company news",
        content: "",
        bullets: [],
        score: buildTradingScore(
          "State Score",
          parseTradingScore(companyNews?.state_score),
        ),
        subsections: [
          buildTradingSubsection(
            "Company",
            parseTradingSubsection(companyNews?.company),
          ),
          buildTradingSubsection(
            "Reportings & Earnings",
            parseTradingSubsection(companyNews?.reportings_and_earnings),
          ),
          buildTradingSubsection(
            "Praises & Complaints",
            parseTradingSubsection(companyNews?.praises_and_complaints),
          ),
          buildTradingSubsection(
            "Collaborations",
            parseTradingSubsection(companyNews?.collaborations),
          ),
          buildTradingSubsection(
            "Misc",
            parseTradingSubsection(companyNews?.misc),
          ),
        ],
      },
      {
        title: "Market news",
        content: "",
        bullets: [],
        score: buildTradingScore(
          "Background Score",
          parseTradingScore(marketNews?.background_score),
        ),
        subsections: [
          buildTradingSubsection(
            "Events",
            parseTradingSubsection(marketNews?.events),
          ),
          buildTradingSubsection(
            "Talks & Postings",
            parseTradingSubsection(marketNews?.talks_and_postings),
          ),
          buildTradingSubsection(
            "Misc",
            parseTradingSubsection(marketNews?.misc),
          ),
        ],
      },
      {
        title: "Market state",
        content: "",
        bullets: [],
        score: buildTradingScore(
          "Market Score",
          parseTradingScore(marketState?.market_score),
        ),
        subsections: [
          buildTradingSubsection(
            "Evaluation",
            parseTradingSubsection(marketState?.evaluation),
          ),
          buildTradingSubsection(
            "Sentiment",
            parseTradingSubsection(marketState?.sentiment),
          ),
          buildTradingSubsection(
            "Misc",
            parseTradingSubsection(marketState?.misc),
          ),
        ],
      },
      {
        title: "Company scope news",
        content: "",
        bullets: [],
        score: buildTradingScore(
          "Industry Score",
          parseTradingScore(companyScopeNews?.industry_score),
        ),
        subsections: [
          buildTradingSubsection(
            "Industry",
            parseTradingSubsection(companyScopeNews?.industry),
          ),
          buildTradingSubsection(
            "Sentiments",
            parseTradingSubsection(companyScopeNews?.sentiments),
          ),
          buildTradingSubsection(
            "Competitors",
            parseTradingSubsection(companyScopeNews?.competitors),
          ),
          buildTradingSubsection(
            "Misc",
            parseTradingSubsection(companyScopeNews?.misc),
          ),
        ],
      },
      {
        title: "Final view",
        content: asString(finalView?.content),
        bullets: asStringArray(finalView?.bullets),
        score: { label: "", value: "", note: "" },
        subsections: [],
      },
    ],
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

function hasCompanyData(companyData: ReportCompanyData): boolean {
  return Object.values(companyData).some((value) => value.length > 0);
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

function renderCompanyData(companyData: ReportCompanyData | undefined): string {
  if (!companyData || !hasCompanyData(companyData)) {
    return "";
  }

  return `<section class="company-info">
    <div class="company-info-heading">
      <span class="report-label">Company Data</span>
      <p>${escapeHtml(companyData.uniqueness || "No clear uniqueness found.")}</p>
    </div>
    <div class="company-metrics">
      ${renderCompanyMetric("Capitalization", companyData.capitalization)}
      ${renderCompanyMetric("Revenue", companyData.revenue)}
      ${renderCompanyMetric(
        "Annual Revenue Growth",
        companyData.annualRevenueGrowth,
      )}
      ${renderCompanyMetric("P/E", companyData.peRatio)}
      ${renderCompanyMetric("Forward P/E", companyData.forwardPeRatio)}
      ${renderCompanyMetric("Gross Margin", companyData.grossMargin)}
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

function renderReportDocument(report: RenderableReport): string {
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
    ${renderCompanyData(report.companyData)}
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

function getMissingTradingFields(report: TradingReport): string[] {
  const missing = [];

  if (!hasCompanyData(report.companyData)) {
    missing.push("company_data");
  }

  for (const section of report.sections.slice(0, 4)) {
    if (!section.score.value) {
      missing.push(`${section.title} score`);
    }

    for (const subsection of section.subsections) {
      if (!subsection.content) {
        missing.push(`${section.title} / ${subsection.title}`);
      }
    }
  }

  const finalView = report.sections.at(-1);
  if (!finalView?.content) {
    missing.push("Final view");
  }

  return missing;
}

export const executeTrading: FunctionToolRunner = (args) => {
  const report = parseTradingReport(args);
  const missing = getMissingTradingFields(report);

  if (missing.length > 0) {
    return JSON.stringify({
      error: "Trading report is missing required content.",
      missing,
    });
  }

  return {
    output:
      "Trading report accepted. Final response must show State Score, Background Score, Market Score, and Industry Score, then give one concise actionable sentence based on those scores.",
    report: {
      documentHtml: renderReportDocument(report),
      filename: report.filename,
    },
  };
};
