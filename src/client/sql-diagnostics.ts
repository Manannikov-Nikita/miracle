import type { Engine, SqlFunctionCatalog } from "../shared/types";
import { isClickhouseAggregateFunction } from "./clickhouse-completion";
import {
  tokenizeSqlContext,
  sqlQueryScopes,
  sqlScopeClauses,
  sqlScopeListItems,
  sqlProjection,
  type SqlContextToken as Token,
} from "./sql-completion-context";

export type SqlDiagnostic = {
  code: string;
  message: string;
  severity: "error" | "warning";
  start: number;
  end: number;
};
export type SqlValidationOptions = {
  engine?: Engine;
  functions?: SqlFunctionCatalog;
};

const keywords = new Set(
  `ALL AND AS ASC BETWEEN BY CASE COLLATE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DESC DISTINCT ELSE END ESCAPE FALSE FIRST FOLLOWING FROM GROUP GROUPS HAVING IN INTERVAL IS LAST LIKE ILIKE NOT NULL NULLS OR ORDER OVER PARTITION PRECEDING RANGE REGEXP RLIKE ROW ROWS THEN TRUE UNBOUNDED WHEN WHERE WITHIN ZONE AT TIME FILTER IGNORE RESPECT YEAR MONTH DAY HOUR MINUTE SECOND WEEK QUARTER`.split(
    " ",
  ),
);
for (const constant of [
  "CURRENT_USER",
  "CURRENT_CATALOG",
  "CURRENT_SCHEMA",
  "CURRENT_PATH",
  "SESSION_USER",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "FOR",
  "BOTH",
  "LEADING",
  "TRAILING",
])
  keywords.add(constant);
const typedLiterals = new Set([
  "DATE",
  "TIME",
  "TIMESTAMP",
  "DECIMAL",
  "DOUBLE",
  "REAL",
  "JSON",
  "UUID",
  "IPADDRESS",
  "VARBINARY",
  "CHAR",
]);
const scalarFunctions = new Set(
  `abs acos asin atan atan2 ceil ceiling floor round trunc truncate sign sqrt pow power exp ln log log10 mod coalesce nullif if ifnull multiif greatest least lower upper initcap length char_length trim ltrim rtrim concat concat_ws substring substr left right replace regexp_replace regexp_extract split split_part cast try_cast todate todatetime todatetime64 tostartofday tostartofweek tostartofmonth tostartofquarter tostartofyear toyear tomonth today tohour formatdatetime datediff date_diff date_trunc date_add date_format to_string tostring toint32 toint64 touint32 touint64 tofloat32 tofloat64 tonumber tonumberornull tonumberorzero todecimal32 todecimal64 todecimal128 tuple tupleelement array arrayelement arrayjoin arraylength isnull isnotnull empty notempty assumenotnull extract now today parse_datetime from_iso8601_timestamp from_unixtime to_unixtime json_extract json_extract_scalar json_value ifnull map map_keys map_values`.split(
    " ",
  ),
);
const trinoAggregates = new Set(
  `any_value arbitrary array_agg avg bool_and bool_or checksum count count_if every geometric_mean max max_by min min_by sum listagg bitwise_and_agg bitwise_or_agg bitwise_xor_agg histogram map_agg map_union multimap_agg approx_distinct approx_most_frequent approx_percentile approx_set merge qdigest_agg tdigest_agg numeric_histogram corr covar_pop covar_samp kurtosis regr_intercept regr_slope skewness stddev stddev_pop stddev_samp variance var_pop var_samp reduce_agg`.split(
    " ",
  ),
);
const windowOnly = new Set(
  `rank denserank dense_rank percentrank percent_rank row_number rownumber ntile lag lead laginframe leadinframe first_value last_value nth_value nonnegativederivative grouping`.split(
    " ",
  ),
);
const unquote = (text: string) =>
  /^["`]/.test(text)
    ? text.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`")
    : text;
const isWord = (token: Token | undefined, word: string) =>
  token?.kind === "word" && token.text.toUpperCase() === word;
const isName = (
  token: Token | undefined,
): token is Token & { kind: "word" | "quoted" } =>
  token?.kind === "word" || token?.kind === "quoted";
const nameKey = (text: string, options: SqlValidationOptions) =>
  options.engine === "clickhouse" ? unquote(text) : unquote(text).toLowerCase();
const keyword = (token: Token) =>
  token.kind === "word" && keywords.has(token.text.toUpperCase());
const aggregate = (name: string, options: SqlValidationOptions) => {
  const lower = unquote(name).toLowerCase();
  if (windowOnly.has(lower)) return false;
  return options.engine === "clickhouse"
    ? isClickhouseAggregateFunction(name, options.functions)
    : trinoAggregates.has(lower);
};
const scalar = (name: string, options: SqlValidationOptions) =>
  scalarFunctions.has(unquote(name).toLowerCase()) ||
  options.functions?.functions.some(
    (fn) =>
      fn.name.toLowerCase() === unquote(name).toLowerCase() && !fn.isAggregate,
  );

const tokenKey = (
  token: Token,
  next: Token | undefined,
  options: SqlValidationOptions,
) =>
  isName(token)
    ? token.kind === "word" && (keyword(token) || next?.text === "(")
      ? token.text.toLowerCase()
      : `id:${nameKey(token.text, options)}`
    : `${token.kind}:${token.text}`;
function tokenKeys(tokens: Token[], options: SqlValidationOptions) {
  return tokens.map((token, index) =>
    tokenKey(token, tokens[index + 1], options),
  );
}
const expressionKey = (tokens: Token[], options: SqlValidationOptions) =>
  JSON.stringify(tokenKeys(tokens, options));
const isReference = (tokens: Token[]) =>
  tokens.length % 2 === 1 &&
  tokens.every((token, index) =>
    index % 2 ? token.text === "." : isName(token),
  );

function referenceAt(
  tokens: Token[],
  start: number,
  end: number,
  options: SqlValidationOptions,
) {
  const token = tokens[start];
  if (!isName(token) || keyword(token) || tokens[start + 1]?.text === "(")
    return;
  const parts = [nameKey(token.text, options)];
  let after = start + 1;
  while (
    after + 1 < end &&
    tokens[after].text === "." &&
    isName(tokens[after + 1])
  ) {
    parts.push(nameKey(tokens[after + 1].text, options));
    after += 2;
  }
  return { parts, after };
}

/** Compare grouping expressions while allowing an unqualified reference to be qualified. */
function groupingMatch(
  tokens: Token[],
  start: number,
  end: number,
  group: Token[],
  options: SqlValidationOptions,
) {
  let index = start;
  for (let other = 0; other < group.length;) {
    if (index >= end) return 0;
    const left = referenceAt(tokens, index, end, options);
    const right = referenceAt(group, other, group.length, options);
    if (left && right) {
      if (
        left.parts.at(-1) !== right.parts.at(-1) ||
        (left.parts.length > 1 &&
          right.parts.length > 1 &&
          JSON.stringify(left.parts) !== JSON.stringify(right.parts))
      )
        return 0;
      index = left.after;
      other = right.after;
    } else {
      if (
        tokenKey(tokens[index], tokens[index + 1], options) !==
        tokenKey(group[other], group[other + 1], options)
      )
        return 0;
      index++;
      other++;
    }
  }
  return index - start;
}

function parentheses(tokens: Token[]) {
  const stack: number[] = [];
  const closes = new Map<number, number>();
  for (let index = 0; index < tokens.length; index++) {
    const text = tokens[index].text;
    if (tokens[index].kind !== "symbol") continue;
    if (text === "(" || text === "[") stack.push(index);
    else if (text === ")" || text === "]") {
      const start = stack.pop();
      if (
        start === undefined ||
        (tokens[start].text === "(" ? ")" : "]") !== text
      )
        return;
      closes.set(start, index);
    }
  }
  return stack.length ? undefined : closes;
}

function stripOuterParentheses(tokens: Token[]) {
  while (
    tokens[0]?.text === "(" &&
    parentheses(tokens)?.get(0) === tokens.length - 1
  )
    tokens = tokens.slice(1, -1);
  return tokens;
}

type Reference = { parts: string[]; start: number; end: number };
type Inspection = {
  refs: Reference[];
  aggregates: Token[];
  uncertain: boolean;
};

/** Inspect a supported expression, shielding aggregate arguments and exact GROUP BY subexpressions. */
function inspectExpression(
  tokens: Token[],
  options: SqlValidationOptions,
  grouped: Token[][] = [],
  countAggregateArgs = false,
): Inspection {
  const result: Inspection = { refs: [], aggregates: [], uncertain: false };
  const closes = parentheses(tokens);
  if (
    !closes ||
    tokens.some(
      (token, index) =>
        isWord(token, "SELECT") ||
        ((token.text === "-" || token.text === "=") &&
          tokens[index + 1]?.text === ">"),
    )
  )
    return { ...result, uncertain: true };
  const walk = (start: number, end: number) => {
    for (let index = start; index < end;) {
      const token = tokens[index];
      let matchedGroup = 0;
      for (const group of grouped) {
        matchedGroup = groupingMatch(tokens, index, end, group, options);
        if (matchedGroup) break;
      }
      if (matchedGroup) {
        index += matchedGroup;
        continue;
      }
      if (!isName(token)) {
        index++;
        continue;
      }
      if (
        token.kind === "word" &&
        typedLiterals.has(token.text.toUpperCase()) &&
        tokens[index + 1]?.kind === "string"
      ) {
        index += 2;
        continue;
      }
      if (tokens[index + 1]?.text === "(" && !isWord(token, "OVER")) {
        const callEnd = closes.get(index + 1);
        if (callEnd === undefined || callEnd >= end) {
          result.uncertain = true;
          return;
        }
        const lower = unquote(token.text).toLowerCase();
        let finalEnd = callEnd;
        // ClickHouse parametric aggregates: quantile(0.5)(amount).
        if (
          aggregate(token.text, options) &&
          tokens[callEnd + 1]?.text === "("
        ) {
          const argumentEnd = closes.get(callEnd + 1);
          if (argumentEnd === undefined) {
            result.uncertain = true;
            return;
          }
          finalEnd = argumentEnd;
        }
        let afterCall = finalEnd + 1;
        if (
          isWord(tokens[afterCall], "FILTER") &&
          tokens[afterCall + 1]?.text === "("
        )
          afterCall = (closes.get(afterCall + 1) ?? end) + 1;
        const isWindow = isWord(tokens[afterCall], "OVER");
        const isAggregate = aggregate(token.text, options) && !isWindow;
        if (isAggregate) result.aggregates.push(token);
        if (isAggregate && !countAggregateArgs) {
          index = afterCall;
          continue;
        }
        if (
          !isAggregate &&
          !isWindow &&
          !windowOnly.has(lower) &&
          !scalar(token.text, options)
        )
          result.uncertain = true;
        if (lower === "cast" || lower === "try_cast") {
          const as = tokens.findIndex(
            (item, i) =>
              i > index + 1 &&
              i < callEnd &&
              item.depth === token.depth + 1 &&
              isWord(item, "AS"),
          );
          walk(index + 2, as < 0 ? callEnd : as);
        } else walk(index + 2, finalEnd);
        index = finalEnd + 1;
        continue;
      }
      if (keyword(token)) {
        // Named windows are definitions, not input columns.
        if (isWord(token, "OVER") && isName(tokens[index + 1])) index++;
        index++;
        continue;
      }
      const parts = [nameKey(token.text, options)];
      let last: Token = token;
      while (tokens[index + 1]?.text === "." && isName(tokens[index + 2])) {
        index += 2;
        last = tokens[index];
        parts.push(nameKey(last.text, options));
      }
      if (tokens[index + 1]?.text === "." && tokens[index + 2]?.text === "*") {
        result.uncertain = true;
        index += 3;
        continue;
      }
      // PostgreSQL-style casts and type parameters are deliberately not inferred.
      if (tokens[index - 1]?.text === ":") result.uncertain = true;
      result.refs.push({ parts, start: token.start, end: last.end });
      index++;
    }
  };
  walk(0, tokens.length);
  return result;
}

type Projection = { tokens: Token[]; alias?: Token; inspection: Inspection };
const sameReference = (left: Reference, right: Reference) =>
  left.parts.at(-1) === right.parts.at(-1) &&
  (left.parts.length === 1 ||
    right.parts.length === 1 ||
    JSON.stringify(left.parts) === JSON.stringify(right.parts));

/** Local, conservative preflight hints. This is not a server parser or permission to execute SQL. */
export function validateSql(
  sql: string,
  options: SqlValidationOptions = {},
): SqlDiagnostic[] {
  // Bound synchronous work in the editor. Oversized/generated SQL is still executable.
  if (sql.length > 200_000) return [];
  const { tokens, clean, complete } = tokenizeSqlContext(sql, options.engine);
  if (
    !complete ||
    tokens.length > 25_000 ||
    tokens.some((token) => token.depth > 128)
  )
    return [];
  const scopes = sqlQueryScopes(tokens, sql.length);
  if (scopes.length > 100) return [];
  const diagnostics: SqlDiagnostic[] = [];
  const add = (
    code: string,
    message: string,
    token: Pick<Token, "start" | "end">,
    severity: SqlDiagnostic["severity"] = "warning",
  ) => {
    if (
      diagnostics.length >= 100 ||
      diagnostics.some(
        (item) =>
          item.code === code &&
          item.start === token.start &&
          item.end === token.end,
      )
    )
      return;
    diagnostics.push({
      code,
      message,
      severity,
      start: token.start,
      end: token.end,
    });
  };
  for (const scope of scopes) {
    const scopeTokens = tokens.filter(
      (token) => token.start >= scope.start && token.start < scope.end,
    );
    if (!parentheses(scopeTokens)) continue;
    const last = scopeTokens.at(-1);
    if (
      !last ||
      [",", ".", "+", "-", "*", "/", "=", "<", ">", "|"].includes(last.text) ||
      (last.kind === "word" &&
        /^(SELECT|FROM|AS|WHERE|PREWHERE|JOIN|ON|AND|OR|BY|HAVING|LIMIT|OFFSET|WHEN|THEN|ELSE)$/.test(
          last.text.toUpperCase(),
        ))
    )
      continue;
    const clauses = sqlScopeClauses(tokens, scope);
    const itemsFor = (index: number) =>
      sqlScopeListItems(
        tokens,
        clauses[index].body,
        clauses[index + 1]?.start ?? scope.end,
        scope.depth,
        true,
      );
    let projectionStart = tokens[scope.index].end;
    if (
      isWord(tokens[scope.index + 1], "DISTINCT") ||
      isWord(tokens[scope.index + 1], "ALL")
    )
      projectionStart = tokens[scope.index + 1].end;
    const selectItems = sqlScopeListItems(
      tokens,
      projectionStart,
      clauses[1]?.start ?? scope.end,
      scope.depth,
      true,
    );
    const projections: Projection[] = selectItems.flatMap((item) => {
      const parsed = sqlProjection(item, clean, scope.depth);
      if (!parsed) return [];
      const last = item.at(-1)!;
      const beforeLast = item.at(-2);
      // The interval unit belongs to its literal, not to an implicit alias.
      const intervalUnit =
        parsed.alias &&
        last.kind === "word" &&
        ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"].includes(
          last.text.toUpperCase(),
        ) &&
        item.some((token) => isWord(token, "INTERVAL")) &&
        (beforeLast?.kind === "string" ||
          beforeLast?.kind === "number" ||
          isWord(beforeLast, "TO"));
      const expressionEnd = intervalUnit
        ? last.end
        : item[0].start + parsed.expression.length;
      const expression = item.filter((token) => token.end <= expressionEnd);
      return [
        {
          tokens: expression,
          alias: parsed.alias && !intervalUnit ? item.at(-1) : undefined,
          inspection: inspectExpression(expression, options),
        },
      ];
    });
    const aliases = new Map<string, Projection>();
    for (const projection of projections) {
      const alias = projection.alias;
      if (!alias) continue;
      const key = nameKey(alias.text, options);
      const previous = aliases.get(key);
      if (
        previous &&
        expressionKey(previous.tokens, options) !==
          expressionKey(projection.tokens, options)
      )
        add(
          "duplicate-alias",
          `Алиас «${unquote(alias.text)}» уже используется у другого выражения в этом SELECT. Задайте другое имя, чтобы ссылки на столбец не были неоднозначными.`,
          alias,
          options.engine === "clickhouse" ? "error" : "warning",
        );
      else aliases.set(key, projection);
    }
    if (options.engine === "clickhouse") {
      for (const projection of projections) {
        const alias = projection.alias;
        if (
          !alias ||
          isReference(projection.tokens) ||
          projection.inspection.uncertain
        )
          continue;
        const key = nameKey(alias.text, options);
        const inputs = inspectExpression(
          projection.tokens,
          options,
          [],
          true,
        ).refs;
        if (!inputs.some((ref) => ref.parts.at(-1) === key)) continue;
        const reused = projections.some(
          (other) =>
            other !== projection &&
            inspectExpression(other.tokens, options, [], true).refs.some(
              (ref) => ref.parts.length === 1 && ref.parts[0] === key,
            ),
        );
        if (reused)
          add(
            "alias-shadowing",
            `Алиас «${unquote(alias.text)}» совпадает с исходным полем, используемым в другом выражении. ClickHouse может подставить сюда выражение алиаса, в том числе создать вложенную агрегацию. Выберите другое имя; поведение зависит от prefer_column_name_to_alias.`,
            alias,
          );
      }
    }
    for (let i = 0; i < clauses.length; i++) {
      if (clauses[i].name !== "where") continue;
      const clauseTokens = tokens.filter(
        (token) =>
          token.start >= clauses[i].body &&
          token.end <= (clauses[i + 1]?.start ?? scope.end),
      );
      for (const fn of inspectExpression(clauseTokens, options).aggregates)
        add(
          "aggregate-in-filter",
          `Агрегатная функция ${fn.text} недоступна в WHERE/PREWHERE. Для фильтрации результата агрегации перенесите условие в HAVING или используйте подзапрос.`,
          fn,
          "error",
        );
    }
    const groupIndex = clauses.findIndex((clause) => clause.name === "groupBy");
    let groups = groupIndex < 0 ? [] : itemsFor(groupIndex);
    if (
      groupIndex >= 0 &&
      (!groups.length ||
        groups.some((group) =>
          group.some(
            (token) =>
              token.kind === "word" &&
              ["ALL", "AUTO", "CUBE", "ROLLUP", "GROUPING", "SETS"].includes(
                token.text.toUpperCase(),
              ),
          ),
        ))
    )
      continue;
    groups = groups.map((item) => {
      const group = stripOuterParentheses(item);
      if (group.length !== 1) return group;
      if (group[0].kind === "number" && /^\d+$/.test(group[0].text))
        return projections[Number(group[0].text) - 1]?.tokens ?? group;
      if (options.engine === "clickhouse" && isName(group[0]))
        return aliases.get(nameKey(group[0].text, options))?.tokens ?? group;
      return group;
    });
    const grouped = groups.map((group) => inspectExpression(group, options));
    const groupRefs = grouped.flatMap((inspection, index) =>
      isReference(groups[index]) ? inspection.refs : [],
    );
    const hasAggregate = projections.some(
      (projection) => projection.inspection.aggregates.length,
    );
    if (groupIndex < 0 && !hasAggregate) continue;
    // Scalar WITH bindings can be constants, lambdas or aggregates. Do not
    // mistake their names for input fields until we resolve those definitions.
    const externalAliases = new Set<string>();
    if (options.engine === "clickhouse") {
      let withStart = -1;
      for (let i = scope.index - 1; i >= 0; i--) {
        if (tokens[i].depth < scope.depth || tokens[i].text === ";") break;
        if (tokens[i].depth !== scope.depth) continue;
        if (isWord(tokens[i], "SELECT")) break;
        if (isWord(tokens[i], "WITH")) {
          withStart = i;
          break;
        }
      }
      if (withStart >= 0) {
        for (let i = withStart + 1; i < scope.index - 1; i++) {
          if (
            tokens[i].depth === scope.depth &&
            isWord(tokens[i], "AS") &&
            isName(tokens[i + 1])
          )
            externalAliases.add(nameKey(tokens[i + 1].text, options));
        }
      }
    }
    const aliasCoverage = new Map<Projection, boolean>();
    const coveredReference = (
      ref: Reference,
      owner: Projection,
      visiting: Set<Projection>,
    ): boolean => {
      if (groupRefs.some((group) => sameReference(ref, group))) return true;
      if (options.engine !== "clickhouse" || ref.parts.length !== 1)
        return false;
      if (externalAliases.has(ref.parts[0])) return true;
      const alias = aliases.get(ref.parts[0]);
      if (!alias) return false;
      // A self-named output still refers to the input within its own expression.
      if (alias === owner) return false;
      // Cyclic or exceptionally deep aliases are left to the server resolver.
      if (visiting.has(alias)) return true;
      if (visiting.size >= 128) return true;
      const cached = aliasCoverage.get(alias);
      if (cached !== undefined) return cached;
      const target = inspectExpression(alias.tokens, options, groups);
      if (target.uncertain) return true;
      const next = new Set(visiting).add(alias);
      const covered = target.refs.every((item) =>
        coveredReference(item, alias, next),
      );
      aliasCoverage.set(alias, covered);
      return covered;
    };
    for (const projection of projections) {
      const inspection = inspectExpression(projection.tokens, options, groups);
      if (inspection.uncertain) continue;
      for (const ref of inspection.refs) {
        if (coveredReference(ref, projection, new Set([projection]))) continue;
        add(
          "missing-group-by",
          `Поле «${sql.slice(ref.start, ref.end)}» используется вне агрегатной функции${groupIndex < 0 ? ", но в запросе есть агрегация" : " и отсутствует в GROUP BY"}. Добавьте поле или соответствующее выражение в GROUP BY либо оберните его в подходящую агрегатную функцию.`,
          ref,
          "error",
        );
      }
    }
  }
  return diagnostics.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}
