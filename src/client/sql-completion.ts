import type {
  Engine,
  QuerySource,
  SchemaTable,
  SqlFunctionCatalog,
} from "../shared/types";
import type { MetadataSchema } from "../shared/metadata";
import type { MetadataStore } from "./metadata-store";
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
    .map((match) => {
      const start =
        match.index! + /^(?:FROM|JOIN)\s+/i.exec(match[0])![0].length;
      return {
        path: parts(match[1]),
        start,
        end: start + match[1].length,
        alias:
          match[2] && !dialectReserved.has(match[2].toUpperCase())
            ? parts(match[2])[0]
            : undefined,
      };
    });
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
  options: { schemas?: MetadataSchema[]; prefix?: string; limit?: number } = {},
): SqlSuggestion[] {
  const scanned = scanSql(beforeCursor, context.engine === "clickhouse");
  if (!scanned.inCode) return [];
  const qualifier = qualifierAtCursor(beforeCursor);
  const suggestions: SqlSuggestion[] = [];
  const limit = options.limit ?? Infinity;
  const prefix = options.prefix?.toLocaleLowerCase();
  const counts = new Map<SqlSuggestion["kind"], number>();
  const canAdd = (kind: SqlSuggestion["kind"]) =>
    (counts.get(kind) || 0) < limit;
  const accepts = (label: string) =>
    prefix === undefined || label.toLocaleLowerCase().startsWith(prefix);
  const add = (item: SqlSuggestion) => {
    if (!canAdd(item.kind)) return;
    counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
    suggestions.push(item);
  };
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
    for (const column of table.columns || []) {
      if (!canAdd("column")) break;
      if (accepts(column.name))
        add({
          label: column.name,
          insertText: quote(column.name, context),
          kind: "column",
          detail: `${tableParts(table).join(".")} · ${column.type}`,
        });
    }
  }
  if (!aliasReference) {
    for (const table of tables) {
      if (!canAdd("table")) break;
      const path = tableParts(table);
      if (
        accepts(table.name) &&
        (!qualifier.length || matches(path.slice(0, -1), qualifier))
      )
        add({
          label: table.name,
          insertText: qualifier.length
            ? quote(table.name, context)
            : path.map((part) => quote(part, context)).join("."),
          kind: "table",
          detail: path.slice(0, -1).join("."),
        });
    }
    const schemas = new Map<string, { insertText: string; name: string }>();
    for (const scope of options.schemas || tables) {
      const path = [scope.catalog, scope.schema].filter(
        (part): part is string => Boolean(part),
      );
      if (!qualifier.length)
        schemas.set(path.join("."), {
          insertText: path.map((part) => quote(part, context)).join("."),
          name: scope.schema,
        });
      else if (matches(path.slice(0, -1), qualifier))
        schemas.set(path[path.length - 1], {
          insertText: quote(path[path.length - 1], context),
          name: scope.schema,
        });
    }
    for (const [label, { insertText, name }] of schemas) {
      if (!canAdd("schema")) break;
      if (accepts(label) || accepts(name))
        add({ label, insertText, kind: "schema" });
    }
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
      for (const keyword of vocabulary) {
        if (!canAdd("keyword")) break;
        const item = keywordSuggestion(keyword, scanned.code);
        if (accepts(item.filterText || item.insertText)) add(item);
      }
      if (context.engine === "clickhouse") {
        const prefix =
          scanned.code.match(/[\p{L}_$][\p{L}\p{N}_$]*$/u)?.[0] || "";
        for (const item of clickhouseFunctionSuggestions(prefix, catalog)) {
          if (!canAdd("function")) break;
          if (accepts(item.filterText || item.label)) add(item);
        }
      }
    }
  }
  if (suggestions.length <= limit) return suggestions;
  // Keep every relevant category available when a large schema has hundreds of
  // identically prefixed tables. Construct at most `limit` items per category,
  // then interleave them into one bounded list; Monaco ranks the matches.
  const groups = (
    ["column", "schema", "keyword", "function", "table"] as const
  ).map((kind) => suggestions.filter((item) => item.kind === kind));
  const bounded: SqlSuggestion[] = [];
  for (let index = 0; bounded.length < limit; index++) {
    let added = false;
    for (const group of groups) {
      if (group[index] && bounded.length < limit) {
        bounded.push(group[index]);
        added = true;
      }
    }
    if (!added) break;
  }
  return bounded;
}

// Explorer and completions use the same store; SQL only supplies foreground
// priorities. The store continues discovering all other metadata in the background.
export function createSqlMetadataLoader(metadata: MetadataStore) {
  return {
    functionCatalog: (connectionId: string) =>
      metadata.functionCatalog(connectionId),
    async tables(
      connectionId: string,
      sql: string,
      context: Context = {},
      beforeCursor = sql,
    ) {
      metadata.activate(connectionId, context);
      const qualifier = qualifierAtCursor(beforeCursor);
      const scopes = new Map<string, MetadataSchema>();
      const wanted = new Map<string, SchemaTable>();
      const addScope = (scope: MetadataSchema) => {
        scopes.set(JSON.stringify([scope.catalog, scope.schema]), scope);
      };
      const addTable = (table: SchemaTable) => {
        wanted.set(JSON.stringify(tableParts(table)), table);
      };
      const defaultSchema = context.schema || context.database;
      if (defaultSchema)
        addScope({ catalog: context.catalog, schema: defaultSchema });
      const resolve = (path: string[]) => {
        if (path.length === 3)
          addTable({ catalog: path[0], schema: path[1], name: path[2] });
        else if (path.length === 2)
          addTable({
            catalog: context.catalog,
            schema: path[0],
            name: path[1],
          });
        else if (path.length === 1 && defaultSchema)
          addTable({
            catalog: context.catalog,
            schema: defaultSchema,
            name: path[0],
          });
      };
      const sqlReferences = references(sql, context);
      const cursor = beforeCursor.length;
      for (const reference of sqlReferences) {
        const trailingDot =
          cursor > reference.end &&
          /^\s*\.\s*$/.test(beforeCursor.slice(reference.end));
        if (
          (cursor >= reference.start && cursor <= reference.end) ||
          trailingDot
        ) {
          // Prefixes such as e/ex/exi are schema-list filters, not exact table
          // requests. Otherwise slow connectors accumulate uncancellable work
          // ahead of the next useful completion as the user types.
          const scopePath = trailingDot
            ? reference.path
            : reference.path.slice(0, -1);
          if (scopePath.length === 2)
            addScope({ catalog: scopePath[0], schema: scopePath[1] });
          else if (scopePath.length === 1 && scopePath[0] !== context.catalog)
            addScope({ catalog: context.catalog, schema: scopePath[0] });
        } else resolve(reference.path);
      }
      const alias =
        qualifier.length === 1 &&
        sqlReferences.some(
          (reference) =>
            reference.alias &&
            normalize(reference.alias) === normalize(qualifier[0]),
        );
      const knownSchemas = metadata.getSnapshot(connectionId).schemas;
      const matchingSchemas = knownSchemas.filter((scope) =>
        matches(
          [scope.catalog, scope.schema].filter((part): part is string =>
            Boolean(part),
          ),
          qualifier,
        ),
      );
      const relationQualifier = /\b(?:FROM|JOIN)\s+[^,;]*$/i.test(
        scanSql(beforeCursor, context.engine === "clickhouse").code,
      );
      if (qualifier.length && !alias) {
        if (matchingSchemas.length) {
          for (const scope of matchingSchemas) addScope(scope);
        } else if (relationQualifier && qualifier.length <= 2) {
          // A bare catalog qualifier only needs schema names, not every table.
          const isCatalog =
            qualifier.length === 1 &&
            (qualifier[0] === context.catalog ||
              knownSchemas.some((scope) => scope.catalog === qualifier[0]));
          if (!isCatalog)
            addScope(
              qualifier.length === 2
                ? { catalog: qualifier[0], schema: qualifier[1] }
                : { catalog: context.catalog, schema: qualifier[0] },
            );
        } else resolve(qualifier);
      }
      for (const table of referencedSqlTables(
        sql,
        metadata.getTables(connectionId),
        context,
      ))
        addTable(table);
      for (const table of metadata.getTables(connectionId))
        if (qualifier.length && matches(tableParts(table), qualifier))
          addTable(table);

      // Start exact SQL targets alongside schema discovery. Neither a long schema
      // listing nor a huge first table page delays an explicitly named table.
      const requested = [...wanted.values()].map(async (table) => {
        await metadata.loadTable(connectionId, table);
        const discovered = metadata
          .getTables(connectionId)
          .find(
            (candidate) =>
              candidate.name === table.name &&
              candidate.schema === table.schema &&
              (!table.catalog || candidate.catalog === table.catalog),
          );
        if (discovered) await metadata.loadColumns(connectionId, discovered);
      });
      await Promise.allSettled([
        metadata.ensureSchemas(connectionId),
        ...[...scopes.values()].map((scope) =>
          metadata.loadTables(connectionId, scope),
        ),
        ...requested,
      ]);
      // A reference without a default schema may become resolvable from pages
      // discovered while the explicit requests above were running.
      const cached = metadata.getTables(connectionId);
      await Promise.allSettled(
        referencedSqlTables(sql, cached, context)
          .filter((table) => !table.columns)
          .map((table) => metadata.loadColumns(connectionId, table)),
      );
      return metadata.getTables(connectionId);
    },
  };
}
