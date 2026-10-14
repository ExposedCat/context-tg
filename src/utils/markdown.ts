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

// Keep offsets intact while hiding syntax whose pipes are literal content.
function maskLiteralMarkdown(text: string): string {
  const mask = (value: string) => value.replaceAll(/[^\r\n]/g, "x");
  let masked = text;
  const fences = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
  for (let match = fences.exec(masked); match; match = fences.exec(masked)) {
    const fence = match[1];
    const closing = new RegExp(
      `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
      "gm",
    );
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(masked) ? closing.lastIndex : masked.length;
    masked =
      masked.slice(0, match.index) +
      mask(masked.slice(match.index, end)) +
      masked.slice(end);
    fences.lastIndex = end;
  }
  return masked
    .replaceAll(/<(pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, mask)
    .replaceAll(/\\[^\r\n]/g, mask)
    .replaceAll(/(?<!`)(`+)(?!`)[\s\S]*?\1(?!`)/g, mask)
    .replaceAll(/\]\((?:\\.|[^)\\])*\)/g, mask);
}

/** Repair explicitly pipe-bounded tables; leave ambiguous pipe prose alone. */
function normalizeMarkdownTables(text: string): string {
  const masked = maskLiteralMarkdown(text);
  const separators = /\|[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|/g;
  let result = "";
  let cursor = 0;

  for (const separator of masked.matchAll(separators)) {
    const separatorStart = separator.index;
    if (separatorStart < cursor) continue;
    const columns = separator[0].split("|").length - 2;
    const headerEnd = masked.slice(0, separatorStart).trimEnd().length;
    const gap = masked.slice(headerEnd, separatorStart);
    if ((gap.match(/\n/g)?.length ?? 0) > 1) continue;
    if (masked[headerEnd - 1] !== "|") continue;

    const lineStart = Math.max(
      cursor,
      masked.lastIndexOf("\n", headerEnd - 1) + 1,
    );
    const headerLine = masked.slice(lineStart, headerEnd);
    const pipes = Array.from(headerLine.matchAll(/\|/g));
    if (pipes.length !== columns + 1) continue;
    const headerStart = lineStart + pipes[0].index;
    const prefix = masked.slice(lineStart, headerStart);
    // Nested tables and indented code need container-aware parsing.
    if (/^(?: {4}|\t|\s*>|\s*(?:[-+*]|\d+[.)])\s)/.test(prefix)) continue;
    if (headerStart < cursor) continue;

    const rows = [text.slice(headerStart, headerEnd), separator[0]];
    let end = separatorStart + separator[0].length;
    while (end < masked.length) {
      const whitespace =
        /^[ \t]*(?:\r?\n[ \t]*)?/.exec(masked.slice(end))?.[0] ?? "";
      const start = end + whitespace.length;
      if (masked[start] !== "|") break;
      let rowEnd = start;
      for (let column = 0; column < columns; column++) {
        rowEnd = masked.indexOf("|", rowEnd + 1);
        if (rowEnd === -1) break;
      }
      if (rowEnd === -1 || /[\r\n]/.test(masked.slice(start, rowEnd))) break;
      rows.push(text.slice(start, rowEnd + 1));
      end = rowEnd + 1;
    }

    const before = text.slice(cursor, headerStart);
    result += before;
    if (result.trimEnd()) {
      const trailing = result.slice(result.trimEnd().length);
      if ((trailing.match(/\n/g)?.length ?? 0) < 2) {
        result = `${result.trimEnd()}\n\n`;
      }
    }
    result += rows.join("\n");
    const after = text.slice(end);
    const whitespace = /^\s*/.exec(after)?.[0] ?? "";
    const lineBreaks = whitespace.match(/\n/g)?.length ?? 0;
    if (after.trimStart() && lineBreaks < 2) {
      result += "\n\n";
      // Keep indentation on the following line (for example, a code block).
      end +=
        lineBreaks === 0 ? whitespace.length : whitespace.lastIndexOf("\n") + 1;
    }
    cursor = end;
  }
  return result + text.slice(cursor);
}

/** Normalize generated Markdown for Telegram rich-message delivery. */
export function normalizeRichMarkdown(text: string): string {
  return escapeSingleDollarSigns(normalizeMarkdownTables(text));
}
