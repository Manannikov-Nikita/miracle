import type { Engine } from "../shared/types";

/** Locate a statement using the same UTF-16 offsets as Monaco's text model. */
export function sqlStatementAt(
  sql: string,
  offset: number,
  engine: Engine,
): string | null {
  const caret = Math.max(
    0,
    Math.min(sql.length, Number.isNaN(offset) ? 0 : Math.trunc(offset)),
  );
  const backslashEscapes = engine === "clickhouse";
  let start = 0;
  let i = 0;
  let hasCode = false;
  let malformedComment = false;
  let previous: string | null = null;

  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i) || (engine === "clickhouse" && c === "#")) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      malformedComment = depth > 0;
      continue;
    }
    if (c === ";") {
      const statement = hasCode ? sql.slice(start, i + 1).trim() : null;
      // A caret just after ';' is the usual editor position at line end.
      // Directly adjacent SQL still owns its own first-character position.
      const atDelimiterEnd =
        caret === i + 1 && (caret === sql.length || /\s/.test(sql[caret]!));
      if (caret <= i || atDelimiterEnd) return statement;
      if (statement) previous = statement;
      start = i + 1;
      hasCode = false;
      i++;
      continue;
    }

    hasCode = true;
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === quote) {
          if (sql[i + 1] === quote) i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      continue;
    }
    if (engine === "clickhouse" && c === "$") {
      // Match the server's ClickHouse heredoc delimiter grammar.
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }
    i++;
  }

  if (hasCode) return sql.slice(start).trim();
  // An unfinished comment is not a harmless trailing suffix: executing the
  // previous query from inside it would be an unexpected fallback.
  return malformedComment ? null : previous;
}
