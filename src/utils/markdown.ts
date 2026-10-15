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

/** Escape currency dollars; preserve Markdown structure and source whitespace. */
export function normalizeRichMarkdown(text: string): string {
  return escapeSingleDollarSigns(text);
}
