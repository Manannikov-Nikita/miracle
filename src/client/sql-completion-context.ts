export type SqlCompletionClause =
  | "select"
  | "from"
  | "join"
  | "where"
  | "on"
  | "groupBy"
  | "having"
  | "orderBy";

export interface SqlProjection {
  expression: string;
  alias?: string;
  reference?: { qualifier: string[]; name: string };
  functionNames: string[];
  hasWindow: boolean;
  hasSubquery: boolean;
}

export interface SqlCompletionContext {
  clause: SqlCompletionClause | undefined;
  scopeSql: string;
  outerScopes: string[];
  projections: SqlProjection[];
  groupBy: string[];
  orderBy: string[];
}

type Engine = "clickhouse" | "trino";
type Token = {
  kind: "word" | "quoted" | "string" | "number" | "symbol";
  text: string;
  start: number;
  end: number;
  depth: number;
};
type Scope = { start: number; end: number; index: number; depth: number };
type Clause = { name?: SqlCompletionClause; start: number; body: number };

const word = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const number = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const isWord = (token: Token | undefined, text: string) =>
  token?.kind === "word" && token.text.toUpperCase() === text;
const isName = (token: Token | undefined) =>
  token?.kind === "word" || token?.kind === "quoted";
const open = (text: string) => text === "(" || text === "[";
const close = (text: string) => text === ")" || text === "]";
const unquote = (text: string) =>
  /^["`]/.test(text)
    ? text.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`")
    : text;

// This is a tolerant lexer for an unfinished editor buffer, not a SQL validator.
// Token offsets let us keep expressions verbatim while ignoring structural
// punctuation inside literals, comments and quoted names.
function tokenize(sql: string, engine?: Engine) {
  const tokens: Token[] = [];
  const clean = sql.split("");
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const start = i;
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i) || sql.startsWith("/*", i)) {
      if (sql.startsWith("--", i)) {
        while (i < sql.length && sql[i] !== "\n") i++;
      } else {
        let nesting = 1;
        i += 2;
        while (i < sql.length && nesting) {
          if (sql.startsWith("/*", i)) {
            nesting++;
            i += 2;
          } else if (sql.startsWith("*/", i)) {
            nesting--;
            i += 2;
          } else i++;
        }
      }
      for (let j = start; j < i; j++) if (clean[j] !== "\n") clean[j] = " ";
      continue;
    }
    let kind: Token["kind"] = "symbol";
    const delimiter = sql[i];
    if (delimiter === "'" || delimiter === '"' || delimiter === "`") {
      kind = delimiter === "'" ? "string" : "quoted";
      i++;
      while (i < sql.length) {
        if (engine === "clickhouse" && sql[i] === "\\")
          i += Math.min(2, sql.length - i);
        else if (sql[i] === delimiter) {
          if (sql[i + 1] === delimiter) i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
    } else {
      word.lastIndex = i;
      number.lastIndex = i;
      const identifier = word.exec(sql);
      const numeric = !identifier && number.exec(sql);
      if (identifier) {
        kind = "word";
        i = word.lastIndex;
      } else if (numeric) {
        kind = "number";
        i = number.lastIndex;
      } else i++;
    }
    const text = sql.slice(start, i);
    if (kind === "symbol" && close(text)) depth = Math.max(0, depth - 1);
    tokens.push({ kind, text, start, end: i, depth });
    if (kind === "symbol" && open(text)) depth++;
  }
  return { tokens, clean: clean.join("") };
}

function queryScopes(tokens: Token[], length: number) {
  const scopes: Scope[] = [];
  const active: Scope[] = [];
  for (const [index, token] of tokens.entries()) {
    while (active.length && active[active.length - 1].depth > token.depth)
      active.pop()!.end = token.start;
    if (
      token.text === ";" ||
      ["UNION", "INTERSECT", "EXCEPT"].some((name) => isWord(token, name))
    ) {
      while (active.length && active[active.length - 1].depth >= token.depth)
        active.pop()!.end = token.start;
    }
    if (isWord(token, "SELECT")) {
      const scope = {
        start: token.start,
        end: length,
        index,
        depth: token.depth,
      };
      scopes.push(scope);
      active.push(scope);
    }
  }
  return scopes;
}

function isDistinctFrom(tokens: Token[], index: number) {
  return (
    isWord(tokens[index], "FROM") &&
    isWord(tokens[index - 1], "DISTINCT") &&
    (isWord(tokens[index - 2], "IS") ||
      (isWord(tokens[index - 2], "NOT") && isWord(tokens[index - 3], "IS")))
  );
}

function clausesFor(tokens: Token[], scope: Scope): Clause[] {
  const clauses: Clause[] = [];
  for (let index = scope.index; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.start >= scope.end) break;
    if (token.depth !== scope.depth || token.kind !== "word") continue;
    if (isDistinctFrom(tokens, index)) continue;
    const upper = token.text.toUpperCase();
    let name: SqlCompletionClause | undefined;
    let body = token.end;
    if (
      (upper === "GROUP" || upper === "ORDER") &&
      isWord(tokens[index + 1], "BY")
    ) {
      name = upper === "GROUP" ? "groupBy" : "orderBy";
      body = tokens[++index].end;
    } else if (
      ["SELECT", "FROM", "JOIN", "WHERE", "ON", "HAVING"].includes(upper)
    ) {
      name = upper.toLowerCase() as SqlCompletionClause;
      // ARRAY JOIN expands array expressions rather than introducing a table.
      if (upper === "JOIN" && isWord(tokens[index - 1], "ARRAY"))
        name = undefined;
    } else if (upper === "PREWHERE") name = "where";
    else if (upper === "USING") name = "on";
    else if (
      ![
        "LIMIT",
        "OFFSET",
        "FETCH",
        "QUALIFY",
        "WINDOW",
        "FORMAT",
        "SETTINGS",
        "WITH",
      ].includes(upper)
    )
      continue;
    clauses.push({ name, start: token.start, body });
  }
  return clauses;
}

const aliasKeywords = new Set([
  "ALL",
  "AND",
  "AS",
  "ASC",
  "BETWEEN",
  "CASE",
  "COLLATE",
  "DESC",
  "DISTINCT",
  "ELSE",
  "END",
  "FALSE",
  "FIRST",
  "FOLLOWING",
  "IN",
  "IS",
  "LAST",
  "LIKE",
  "NOT",
  "NULL",
  "NULLS",
  "OR",
  "OVER",
  "PRECEDING",
  "THEN",
  "TRUE",
  "WHEN",
]);
const binaryWords = new Set([
  "AND",
  "AS",
  "BETWEEN",
  "COLLATE",
  "ELSE",
  "ESCAPE",
  "FROM",
  "IN",
  "ILIKE",
  "IS",
  "LIKE",
  "NOT",
  "OR",
  "REGEXP",
  "RLIKE",
  "THEN",
  "WHEN",
]);
for (const keyword of binaryWords) aliasKeywords.add(keyword);

function projection(
  tokens: Token[],
  clean: string,
  depth: number,
): SqlProjection | undefined {
  if (!tokens.length) return;
  let end = tokens.length;
  let alias: string | undefined;
  const last = tokens[end - 1];
  const previous = tokens[end - 2];
  if (
    isName(last) &&
    last.depth === depth &&
    previous?.depth === depth &&
    isWord(previous, "AS")
  ) {
    alias = last.text;
    end -= 2;
  } else if (
    tokens.length > 1 &&
    isName(last) &&
    last.depth === depth &&
    (last.kind === "quoted" || !aliasKeywords.has(last.text.toUpperCase())) &&
    previous.end < last.start &&
    (previous.kind !== "symbol" || close(previous.text)) &&
    !(
      previous.kind === "word" && binaryWords.has(previous.text.toUpperCase())
    ) &&
    !(
      isWord(previous, "ZONE") &&
      isWord(tokens[end - 3], "TIME") &&
      isWord(tokens[end - 4], "AT")
    )
  ) {
    alias = last.text;
    end--;
  }
  const expressionTokens = tokens.slice(0, end);
  if (!expressionTokens.length) return;
  const expression = clean
    .slice(expressionTokens[0].start, expressionTokens.at(-1)!.end)
    .trim();
  const identifiers: string[] = [];
  const isReference =
    expressionTokens.every((token, index) => {
      if (index % 2) return token.text === ".";
      if (
        !isName(token) ||
        (token.kind === "word" && aliasKeywords.has(token.text.toUpperCase()))
      )
        return false;
      identifiers.push(unquote(token.text));
      return true;
    }) && expressionTokens.length % 2 === 1;
  const functionNames = expressionTokens
    .filter(
      (token, index) =>
        isName(token) &&
        expressionTokens[index + 1]?.text === "(" &&
        !isWord(token, "OVER"),
    )
    .map((token) => unquote(token.text));
  return {
    expression,
    ...(alias ? { alias } : {}),
    ...(isReference
      ? {
          reference: {
            qualifier: identifiers.slice(0, -1),
            name: identifiers.at(-1)!,
          },
        }
      : {}),
    functionNames,
    hasWindow: expressionTokens.some((token) => isWord(token, "OVER")),
    hasSubquery: expressionTokens.some((token) => isWord(token, "SELECT")),
  };
}

function listItems(
  tokens: Token[],
  start: number,
  end: number,
  depth: number,
  includeLast: boolean,
) {
  const items: Token[][] = [];
  let item: Token[] = [];
  for (const token of tokens) {
    if (token.start < start) continue;
    if (token.end > end) break;
    if (token.text === "," && token.depth === depth) {
      if (item.length) items.push(item);
      item = [];
    } else item.push(token);
  }
  if (includeLast && item.length) items.push(item);
  return items;
}

function completedList(
  name: "groupBy" | "orderBy",
  clauses: Clause[],
  tokens: Token[],
  clean: string,
  scope: Scope,
  cursor: number,
) {
  const index = clauses.findIndex((item) => item.name === name);
  if (index < 0 || clauses[index].body > cursor) return [];
  const nextClause = clauses[index + 1]?.start;
  const end = Math.min(cursor, nextClause ?? scope.end);
  return listItems(
    tokens,
    clauses[index].body,
    end,
    scope.depth,
    nextClause !== undefined && nextClause <= cursor,
  )
    .map((item) => {
      if (name === "orderBy") {
        if (
          isWord(item.at(-2), "NULLS") &&
          (isWord(item.at(-1), "FIRST") || isWord(item.at(-1), "LAST"))
        )
          item = item.slice(0, -2);
        if (isWord(item.at(-1), "ASC") || isWord(item.at(-1), "DESC"))
          item = item.slice(0, -1);
      }
      return item.length
        ? clean.slice(item[0].start, item.at(-1)!.end).trim()
        : "";
    })
    .filter(Boolean);
}

/** Stable duplicate key without changing whitespace or case inside literals. */
export function sqlExpressionKey(expression: string, engine?: Engine) {
  return JSON.stringify(
    tokenize(expression, engine).tokens.map((token) =>
      token.kind === "word" ? token.text.toLowerCase() : token.text,
    ),
  );
}

function visibleScope(
  sql: string,
  scope: Scope,
  scopes: Scope[],
  tokens: Token[],
) {
  // Preserve absolute offsets for callers that share the original cursor, but
  // hide other query blocks from the relation/alias metadata resolver.
  const visible = sql
    .split("")
    .map((char, index) =>
      index >= scope.start && index < scope.end
        ? char
        : char === "\n"
          ? char
          : " ",
    );
  const mask = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (visible[i] !== "\n") visible[i] = " ";
  };
  for (const nested of scopes) {
    if (
      nested.start <= scope.start ||
      nested.start >= scope.end ||
      nested.depth <= scope.depth
    )
      continue;
    mask(nested.start, Math.min(nested.end, scope.end));
  }
  // FROM in a null-safe comparison does not introduce a relation.
  for (const [index, token] of tokens.entries()) {
    if (
      token.start >= scope.start &&
      token.start < scope.end &&
      isDistinctFrom(tokens, index)
    )
      mask(token.start, token.end);
  }
  return visible.join("");
}

export function sqlCompletionContext(
  sql: string,
  cursor: number,
  engine?: Engine,
): SqlCompletionContext {
  cursor = Math.max(0, Math.min(cursor, sql.length));
  const { tokens, clean } = tokenize(sql, engine);
  const scopes = queryScopes(tokens, sql.length);
  const scope = scopes
    .filter((item) => item.start <= cursor && item.end >= cursor)
    .sort((a, b) => b.depth - a.depth || b.start - a.start)[0];
  if (!scope) {
    return {
      clause: undefined,
      scopeSql: "",
      outerScopes: [],
      projections: [],
      groupBy: [],
      orderBy: [],
    };
  }
  const clauses = clausesFor(tokens, scope);
  let lastToken: Token | undefined;
  for (const token of tokens) {
    if (token.start >= cursor) break;
    lastToken = token;
  }
  const cursorDepth = lastToken
    ? lastToken.depth + (open(lastToken.text) ? 1 : 0)
    : 0;
  let clause: SqlCompletionClause | undefined;
  if (cursorDepth === scope.depth) {
    for (const item of clauses) {
      if (item.body > cursor) break;
      clause = item.name;
    }
  }
  const selectEnd = clauses[1]?.start ?? scope.end;
  let projectionStart = tokens[scope.index].end;
  if (
    isWord(tokens[scope.index + 1], "DISTINCT") ||
    isWord(tokens[scope.index + 1], "ALL")
  )
    projectionStart = tokens[scope.index + 1].end;
  const projections = listItems(
    tokens,
    projectionStart,
    selectEnd,
    scope.depth,
    true,
  )
    .map((item) => projection(item, clean, scope.depth))
    .filter((item): item is SqlProjection => item !== undefined);
  return {
    clause,
    scopeSql: visibleScope(sql, scope, scopes, tokens),
    outerScopes: scopes
      .filter(
        (outer) =>
          outer.depth < scope.depth &&
          outer.start < scope.start &&
          outer.end >= scope.end,
      )
      .sort((a, b) => b.depth - a.depth)
      .map((outer) => visibleScope(sql, outer, scopes, tokens)),
    projections,
    groupBy: completedList("groupBy", clauses, tokens, clean, scope, cursor),
    orderBy: completedList("orderBy", clauses, tokens, clean, scope, cursor),
  };
}
