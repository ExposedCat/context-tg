import type { FunctionToolRunner } from "./types.ts";

export type LlmHtmlReport = {
  htmlString: string;
  filename: string;
};

export const toolDefinition = {
  type: "function",
  name: "send_html_report",
  description:
    "Attach a long research report as an HTML file. Use this only for long research purposes when the report is too large or rich for a normal chat reply. Put the full report in html_string and provide a short, descriptive filename. After using this tool, the normal assistant response must be a 2-3 sentence TL;DR of the report's conclusion, strongest evidence, and most important caveat; do not respond with only a generic attachment notice.",
  parameters: {
    type: "object",
    properties: {
      html_string: {
        type: "string",
        description:
          "The complete HTML report content to attach as a document. Should contain nice <style> tag.",
      },
      filename: {
        type: "string",
        description:
          "A short filename for the report. The bot will normalize it and ensure it uses the .html extension.",
      },
    },
    required: ["html_string", "filename"],
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

export const execute: FunctionToolRunner = (args) => {
  const htmlString =
    typeof args?.html_string === "string" ? args.html_string : "";
  const filename = normalizeReportFilename(args?.filename);

  if (!htmlString.trim()) {
    return JSON.stringify({ error: "html_string must not be empty." });
  }

  return {
    output:
      "HTML report accepted. Final response must be a 2-3 sentence TL;DR of the report's conclusion, strongest evidence, and most important caveat; do not respond with only a generic attachment notice.",
    htmlReport: {
      htmlString,
      filename,
    },
  };
};
