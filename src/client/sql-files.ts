import { format } from "sql-formatter";
import type { Engine } from "../shared/types";
import { sqlSelectAliasOffsets } from "./sql-completion-context";
/** Dialect-aware whitespace formatting; callers apply only successful edits. */
export function formatSql(sql: string, engine: Engine): string {
  const formatted = format(sql, {
    language: engine,
    tabWidth: 4,
    keywordCase: "upper",
    functionCase: engine === "clickhouse" ? "preserve" : "upper",
    linesBetweenQueries: 2,
  });
  const edits: { start: number; end: number; spaces: string }[] = [];
  for (const offsets of sqlSelectAliasOffsets(formatted, engine)) {
    const columns = offsets.flatMap((end) => {
      const lineStart = formatted.lastIndexOf("\n", end - 1) + 1;
      const prefix = formatted.slice(lineStart, end);
      const width = prefix.trimEnd().length;
      // Leave standalone AS lines at the formatter's indentation.
      return prefix.trim() ? [{ start: lineStart + width, end, width }] : [];
    });
    if (columns.length < 2) continue;
    const column = columns.reduce(
      (max, { width }) => Math.max(max, width + 1),
      0,
    );
    for (const { start, end, width } of columns)
      edits.push({ start, end, spaces: " ".repeat(column - width) });
  }
  // Compose once from original offsets, also for large projection lists.
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end, spaces } of edits.sort(
    (a, b) => a.start - b.start,
  )) {
    parts.push(formatted.slice(cursor, start), spaces);
    cursor = end;
  }
  parts.push(formatted.slice(cursor));
  return parts.join("");
}
export function sqlFileName(name: string): string {
  const clean = name.trim().replace(/[\\/\u0000-\u001f]/g, "_") || "query";
  return /\.sql$/i.test(clean) ? clean : `${clean}.sql`;
}
