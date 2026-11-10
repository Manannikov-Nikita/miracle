/** The original source is never rewritten; this range is presentation-only. */
export function markdownFrontmatterEnd(source: string): number {
  const opening = /^\uFEFF?---[ \t]*\r?(?:\n|$)/.exec(source);
  if (!opening) return 0;
  let position = opening[0].length;
  let firstContent: string | undefined;
  while (position < source.length) {
    const newline = source.indexOf("\n", position);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source
      .slice(position, newline < 0 ? end : newline)
      .replace(/\r$/, "");
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) return end;
    if (firstContent === undefined && line.trim() && !line.startsWith("#"))
      firstContent = line;
    position = end;
  }
  // Keep an unfinished metadata mapping editable, without turning an ordinary
  // leading horizontal rule followed by Markdown into front matter.
  return firstContent && /^[\w.-]+[ \t]*:/.test(firstContent)
    ? source.length
    : 0;
}

/** Blank metadata for Markdown parsers while preserving every source offset. */
export function markdownBodySource(source: string): string {
  const end = markdownFrontmatterEnd(source);
  return end
    ? source.slice(0, end).replace(/[^\r\n]/g, " ") + source.slice(end)
    : source;
}
