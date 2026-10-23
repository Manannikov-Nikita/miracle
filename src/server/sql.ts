/** Defense in depth. Engine users MUST also have read-only database privileges. */
export function assertReadOnly(sql: string): void {
  readOnlyDelimiter(sql, true);
}

/** Trino's HTTP statement protocol accepts SQL without a final CLI delimiter. */
export function normalizeTrinoSql(sql: string): string {
  const delimiter = readOnlyDelimiter(sql, false);
  return delimiter < 0 ? sql : sql.slice(0, delimiter) + sql.slice(delimiter + 1);
}

function readOnlyDelimiter(sql: string, backslashEscapes: boolean): number {
  if (typeof sql !== "string" || !sql.trim() || sql.length > 1000000)
    throw new Error("SQL пустой или слишком большой");
  const tokens: string[] = [];
  let i = 0;
  let ended = false;
  let delimiter = -1;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i) || c === "#") {
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
      if (depth) throw new Error("Незакрытый SQL комментарий");
      continue;
    }
    if (ended) throw new Error("Разрешён только один SQL запрос");
    if (c === ";") {
      ended = true;
      delimiter = i;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let closed = false;
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error("Незакрытая SQL строка");
      continue;
    }
    if (c === "$") {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error("Незакрытая SQL строка");
        i = end + tag.length;
        continue;
      }
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0];
    if (word) {
      tokens.push(word.toUpperCase());
      i += word.length;
    } else i++;
  }
  if (
    !["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(
      tokens[0] || "",
    )
  )
    throw new Error("Разрешены только запросы чтения");
  const forbidden = new Set([
    "INSERT",
    "UPDATE",
    "DELETE",
    "ALTER",
    "DROP",
    "CREATE",
    "REPLACE",
    "TRUNCATE",
    "ATTACH",
    "DETACH",
    "RENAME",
    "GRANT",
    "REVOKE",
    "OPTIMIZE",
    "SYSTEM",
    "KILL",
    "CALL",
    "EXECUTE",
    "PREPARE",
    "DEALLOCATE",
    "SET",
    "RESET",
    "USE",
    "INTO",
    "OUTFILE",
    "FORMAT",
  ]);
  if (tokens.some((t) => forbidden.has(t)))
    throw new Error("SQL содержит запрещённую операцию");
  return delimiter;
}
