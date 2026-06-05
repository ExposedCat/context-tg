export function startsWithCommandPrefix(text: string | undefined): boolean {
  return text?.trimStart().startsWith("/") === true;
}
