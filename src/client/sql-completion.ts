import type {
  Engine,
  QuerySource,
  SchemaTable,
  SqlFunctionCatalog,
} from "../shared/types";
import {
  clickhouseFunctionSuggestions,
  clickhouseKeywords,
} from "./clickhouse-completion";

type Context = Pick<QuerySource, "database" | "catalog" | "schema"> & {
  engine?: Engine;
};
export interface SqlSuggestion {
  label: string;
  insertText: string;
  kind: "keyword" | "table" | "column" | "schema" | "function";
  documentation?: string;
  filterText?: string;
  sortText?: string;
  detail?: string;
}

const keywords = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "ON",
  "AS",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS NULL",
  "IS NOT NULL",
  "IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "DISTINCT",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION ALL",
  "WITH",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "ASC",
  "DESC",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "OVER",
  "PARTITION BY",
];
const identifier =
  '(?:[\\p{L}_$][\\p{L}\\p{N}_$]*|"(?:[^"]|"")+"|`(?:[^`]|``)+`)';
const qualifiedIdentifier = `${identifier}(?:\\s*\\.\\s*${identifier}){0,2}`;
const reserved = new Set(keywords.flatMap((word) => word.split(" ")));
for (const word of ["OUTER", "USING", "SET", "VALUES", "FETCH", "QUALIFY"])
  reserved.add(word);
const clickhouseReserved = new Set([
  ...reserved,
  ...clickhouseKeywords.flatMap((keyword) => keyword.split(" ")),
]);
const reservedFor = (context: Context) =>
  context.engine === "clickhouse" ? clickhouseReserved : reserved;
const normalize = (value: string) => value.toLocaleLowerCase();
const parts = (value: string) =>
  (value.match(new RegExp(identifier, "gu")) || []).map((part) =>
    /^["`]/.test(part)
      ? part.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`")
      : part,
  );
const tableParts = (table: SchemaTable) =>
  [table.catalog, table.schema, table.name].filter((part): part is string =>
    Boolean(part),
  );
const matches = (actual: string[], suffix: string[]) =>
  actual.length >= suffix.length &&
  suffix.every(
    (part, i) =>
      normalize(part) === normalize(actual[actual.length - suffix.length + i]),
  );
const quote = (value: string, context: Context = {}) =>
  /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(value) &&
  !reservedFor(context).has(value.toUpperCase())
    ? value
    : `"${value.replace(/"/g, '""')}"`;

function qualifierAtCursor(beforeCursor: string) {
  const prefix = beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1);
  const match = prefix.match(
    new RegExp(`(${qualifiedIdentifier})\\.([\\p{L}\\p{N}_$]*)$`, "u"),
  );
  return match ? parts(match[1]) : [];
}

// Preserve offsets and quoted identifiers while masking literals/comments. The
// cursor state also prevents suggestions inside an unfinished literal/comment.
function scanSql(sql: string, backslashEscapes = false) {
  const chars = sql.split("");
  let state: "code" | "string" | "line" | "block" | "double" | "backtick" =
    "code";
  const mask = (index: number) => {
    if (chars[index] !== "\n") chars[index] = " ";
  };
  for (let i = 0; i < chars.length; i++) {
    const current = sql[i];
    const next = sql[i + 1];
    if (state === "line") {
      if (current === "\n") state = "code";
      else mask(i);
    } else if (state === "block") {
      mask(i);
      if (current === "*" && next === "/") {
        mask(++i);
        state = "code";
      }
    } else if (state === "string") {
      mask(i);
      if (backslashEscapes && current === "\\" && next !== undefined) mask(++i);
      else if (current === "'" && next === "'") mask(++i);
      else if (current === "'") state = "code";
    } else if (state === "double" || state === "backtick") {
      const delimiter = state === "double" ? '"' : "`";
      if (current === delimiter && next === delimiter) i++;
      else if (current === delimiter) state = "code";
    } else if (current === "-" && next === "-") {
      mask(i);
      mask(++i);
      state = "line";
    } else if (current === "/" && next === "*") {
      mask(i);
      mask(++i);
      state = "block";
    } else if (current === "'") {
      mask(i);
      state = "string";
    } else if (current === '"') state = "double";
    else if (current === "`") state = "backtick";
  }
  return { code: chars.join(""), inCode: state === "code" };
}

function keywordSuggestion(
  keyword: string,
  codeBeforeCursor: string,
): SqlSuggestion {
  const words = keyword.split(" ");
  // Monaco replaces the current word. Strip only complete preceding words so
  // accepting JOIN after ARRAY or ARRAY J produces exactly ARRAY JOIN.
  const typed = codeBeforeCursor.match(/[\p{L}\p{N}_$]*$/u)?.[0] || "";
  const preceding = codeBeforeCursor.slice(
    0,
    codeBeforeCursor.length - typed.length,
  );
  for (let consumed = words.length - 1; consumed > 0; consumed--) {
    const expression = new RegExp(
      `\\b${words.slice(0, consumed).join("\\s+")}\\s+$`,
      "i",
    );
    if (expression.test(preceding)) {
      const remaining = words.slice(consumed).join(" ");
      const matchesPrefix = remaining
        .toLowerCase()
        .startsWith(typed.toLowerCase());
      return {
        label: keyword,
        insertText: remaining,
        // Monaco ranks exact case matches before sortText. Match the typed
        // prefix's case while retaining SQL keyword casing on insertion.
        filterText: matchesPrefix
          ? typed + remaining.slice(typed.length)
          : remaining,
        ...(matchesPrefix ? { sortText: `0:${keyword}` } : {}),
        kind: "keyword",
      };
    }
  }
  return { label: keyword, insertText: keyword, kind: "keyword" };
}

function references(sql: string, context: Context = {}) {
  const dialectReserved = reservedFor(context);
  const expression = new RegExp(
    `\\b(?:FROM|JOIN)\\s+(${qualifiedIdentifier})(?:\\s+(?:AS\\s+)?((?!(?:${[...dialectReserved].join("|")})\\b)${identifier}))?`,
    "giu",
  );
  const code = scanSql(sql, context.engine === "clickhouse").code;
  return [...code.matchAll(expression)]
    .filter(
      (match) =>
        context.engine !== "clickhouse" ||
        !/\bARRAY\s+$/i.test(code.slice(0, match.index)),
    )
    .map((match) => ({
      path: parts(match[1]),
      alias:
        match[2] && !dialectReserved.has(match[2].toUpperCase())
          ? parts(match[2])[0]
          : undefined,
    }));
}

export function referencedSqlTables(
  sql: string,
  tables: SchemaTable[],
  context: Context = {},
) {
  const selected = new Set<SchemaTable>();
  for (const reference of references(sql, context)) {
    const candidates = tables.filter((table) =>
      matches(tableParts(table), reference.path),
    );
    const preferred = candidates.filter(
      (table) =>
        (!context.catalog || table.catalog === context.catalog) &&
        (!(context.schema || context.database) ||
          table.schema === (context.schema || context.database)),
    );
    for (const table of preferred.length ? preferred : candidates)
      selected.add(table);
  }
  return [...selected];
}

export function sqlSuggestions(
  sql: string,
  beforeCursor: string,
  tables: SchemaTable[],
  context: Context = {},
  catalog?: SqlFunctionCatalog,
): SqlSuggestion[] {
  const scanned = scanSql(beforeCursor, context.engine === "clickhouse");
  if (!scanned.inCode) return [];
  const qualifier = qualifierAtCursor(beforeCursor);
  const suggestions: SqlSuggestion[] = [];
  const referenced = referencedSqlTables(sql, tables, context);
  const aliasReference =
    qualifier.length === 1
      ? references(sql, context).find(
          (reference) =>
            reference.alias &&
            normalize(reference.alias) === normalize(qualifier[0]),
        )
      : undefined;
  const columnTables = qualifier.length
    ? aliasReference
      ? referencedSqlTables(
          `FROM ${aliasReference.path.map((part) => quote(part, context)).join(".")}`,
          tables,
          context,
        )
      : tables.filter((table) => matches(tableParts(table), qualifier))
    : referenced;
  for (const table of columnTables) {
    for (const column of table.columns || [])
      suggestions.push({
        label: column.name,
        insertText: quote(column.name, context),
        kind: "column",
        detail: `${tableParts(table).join(".")} · ${column.type}`,
      });
  }
  if (!aliasReference) {
    for (const table of tables) {
      const path = tableParts(table);
      if (!qualifier.length || matches(path.slice(0, -1), qualifier))
        suggestions.push({
          label: table.name,
          insertText: qualifier.length
            ? quote(table.name, context)
            : path.map((part) => quote(part, context)).join("."),
          kind: "table",
          detail: path.slice(0, -1).join("."),
        });
    }
    const schemas = new Map<string, string>();
    for (const table of tables) {
      const path = tableParts(table).slice(0, -1);
      if (!qualifier.length)
        schemas.set(
          path.join("."),
          path.map((part) => quote(part, context)).join("."),
        );
      else if (matches(path.slice(0, -1), qualifier))
        schemas.set(
          path[path.length - 1],
          quote(path[path.length - 1], context),
        );
    }
    for (const [label, insertText] of schemas)
      suggestions.push({ label, insertText, kind: "schema" });
    if (!qualifier.length) {
      const vocabulary =
        context.engine === "clickhouse"
          ? [
              ...keywords.filter(
                (keyword) =>
                  !["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(keyword),
              ),
              ...clickhouseKeywords,
            ]
          : keywords;
      suggestions.push(
        ...vocabulary.map((keyword) =>
          keywordSuggestion(keyword, scanned.code),
        ),
      );
      if (context.engine === "clickhouse") {
        const prefix =
          scanned.code.match(/[\p{L}_$][\p{L}\p{N}_$]*$/u)?.[0] || "";
        suggestions.push(...clickhouseFunctionSuggestions(prefix, catalog));
      }
    }
  }
  return suggestions;
}

// Each connection owns its metadata, independent of the Explorer's visibility or selection.
// Share in-flight work; remove failed requests so a later completion can retry.
export function createSqlMetadataLoader(
  request: <T>(path: string) => Promise<T>,
) {
  const schemas = new Map<string, Promise<SchemaTable[]>>();
  const functionCatalogs = new Map<string, Promise<SqlFunctionCatalog>>();
  const columns = new Map<
    string,
    Promise<NonNullable<SchemaTable["columns"]>>
  >();
  function schema(connectionId: string) {
    let pending = schemas.get(connectionId);
    if (!pending) {
      pending = request<SchemaTable[]>(
        `/api/connections/${encodeURIComponent(connectionId)}/schema`,
      );
      schemas.set(connectionId, pending);
      pending.catch(() => {
        if (schemas.get(connectionId) === pending) schemas.delete(connectionId);
      });
    }
    return pending;
  }
  return {
    schema,
    functionCatalog(connectionId: string) {
      let pending = functionCatalogs.get(connectionId);
      if (!pending) {
        pending = request<SqlFunctionCatalog>(
          `/api/connections/${encodeURIComponent(connectionId)}/functions`,
        );
        functionCatalogs.set(connectionId, pending);
        pending.catch(() => {
          if (functionCatalogs.get(connectionId) === pending)
            functionCatalogs.delete(connectionId);
        });
      }
      return pending;
    },
    async tables(
      connectionId: string,
      sql: string,
      context: Context = {},
      beforeCursor = sql,
    ) {
      const tables = await schema(connectionId);
      const qualifier = qualifierAtCursor(beforeCursor);
      const referenced = [
        ...new Set([
          ...referencedSqlTables(sql, tables, context),
          ...tables.filter(
            (table) =>
              qualifier.length && matches(tableParts(table), qualifier),
          ),
        ]),
      ];
      await Promise.all(
        referenced.map(async (table) => {
          if (table.columns) return;
          const key = JSON.stringify([
            connectionId,
            table.catalog,
            table.schema,
            table.name,
          ]);
          let pending = columns.get(key);
          if (!pending) {
            const query = new URLSearchParams({
              schema: table.schema,
              table: table.name,
              ...(table.catalog ? { catalog: table.catalog } : {}),
            });
            pending = request<NonNullable<SchemaTable["columns"]>>(
              `/api/connections/${encodeURIComponent(connectionId)}/columns?${query}`,
            );
            columns.set(key, pending);
            pending.catch(() => {
              if (columns.get(key) === pending) columns.delete(key);
            });
          }
          try {
            table.columns = await pending;
          } catch {
            /* Table suggestions remain available when columns fail. */
          }
        }),
      );
      return tables;
    },
  };
}
