import { format } from "sql-formatter";
import type { Engine } from "../shared/types";
/** Dialect-aware whitespace formatting; callers apply only successful edits. */
export function formatSql(sql: string, engine: Engine): string {
  return format(sql, {
    language: engine,
    tabWidth: 4,
    keywordCase: "upper",
    functionCase: engine === "clickhouse" ? "preserve" : "upper",
    linesBetweenQueries: 2,
  });
}
export function sqlFileName(name: string): string {
  const clean = name.trim().replace(/[\\/\u0000-\u001f]/g, "_") || "query";
  return /\.sql$/i.test(clean) ? clean : `${clean}.sql`;
}
