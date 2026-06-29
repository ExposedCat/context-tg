export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

export function normalizeWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

export function truncateCodePoints(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

export function normalizeHtmlFilename(
  value: unknown,
  fallback = "research-report.html",
): string {
  const rawFilename = typeof value === "string" ? value.trim() : "";
  const safeFilename = rawFilename
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/[^a-z0-9._ -]/gi, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const filename = safeFilename || fallback;

  return /\.html?$/i.test(filename) ? filename : `${filename}.html`;
}
