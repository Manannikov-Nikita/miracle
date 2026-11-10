function markdownCell(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\|`*_\[\]~$]/g, "\\$&")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/** Export cell text, never active Markdown/HTML supplied by query results. */
export function tableToMarkdown(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (!headers.length) return "";
  const row = (cells: readonly string[]) =>
    `| ${headers.map((_, index) => markdownCell(cells[index] ?? "")).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join(
    "\n",
  );
}
