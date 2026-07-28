export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

export function escapeXml(text: string): string {
  return escapeHtml(text);
}

export function escapeXmlAttribute(text: string): string {
  return escapeHtmlAttribute(text);
}

export function normalizeWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function isEscapedCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}

export function escapeSingleDollarSigns(text: string): string {
  let escaped = "";

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (character !== "$") {
      escaped += character;
      continue;
    }

    if (text[index + 1] === "$") {
      escaped += "$$";
      index++;
      continue;
    }

    escaped += isEscapedCharacter(text, index) ? "$" : "\\$";
  }

  return escaped;
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
