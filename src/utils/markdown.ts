function isEscapedCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}

function escapeSingleDollarSigns(text: string): string {
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

/** Escape currency dollars outside HTML tables; preserve markup and whitespace. */
export function normalizeRichMarkdown(text: string): string {
  const tables = /<table(?=[\s>])[^>]*>[\s\S]*?(?:<\/table\s*>|$)/gi;
  let normalized = "";
  let cursor = 0;

  for (const match of text.matchAll(tables)) {
    normalized += escapeSingleDollarSigns(text.slice(cursor, match.index));
    // Telegram does not parse Markdown escapes in HTML tables. Also preserve
    // unfinished tables while a response is streaming.
    normalized += match[0];
    cursor = match.index + match[0].length;
  }

  return normalized + escapeSingleDollarSigns(text.slice(cursor));
}
