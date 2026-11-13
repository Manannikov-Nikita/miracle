import {
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBResultReader,
} from "@duckdb/node-api";
import { Decimal } from "decimal.js";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { Cell, ResultSet } from "../shared/types.js";
import {
  VISUAL_TABLE_LIMITS as limits,
  isVisualTableNumeric,
  createResultVisualTable,
  visualTableSourceSchema,
  visualTableSpecSchema,
  type VisualTableColumn,
  type VisualTableResult,
  type VisualTableScalar,
  type VisualTableSpec,
} from "../shared/visual-table.js";
import {
  parseVisualTableFormula,
  visualFormulaDependencies,
  type VisualFormulaNode,
} from "../shared/visual-table-formula.js";

export interface EvaluateVisualTableInput {
  table: VisualTableSpec;
  source?: { result: ResultSet; rows: Cell[][] };
  offset?: number;
  limit?: number;
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const issue = (message: string, statusCode = 422) =>
  Object.assign(new Error(message), { statusCode });
const executionMs = 15000;
const maxExpressionBytes = 256 * 1024;
const maxCompiledSqlBytes = 1024 * 1024;
function joinSql(parts: string[], maximum = maxExpressionBytes): string {
  let bytes = 0;
  for (const part of parts) {
    bytes += Buffer.byteLength(part);
    if (bytes > maximum)
      throw issue(
        "Формулы слишком сложные: превышен допустимый размер SQL. Разделите вычисления на несколько столбцов.",
      );
  }
  return parts.join("");
}
function alwaysNull(
  node: VisualFormulaNode,
  columnFormula: (id: string) => VisualFormulaNode | undefined,
  visited = new Set<string>(),
): boolean {
  if (node.kind === "literal") return node.value === null;
  if (node.kind === "column") {
    if (visited.has(node.id)) return false;
    const formula = columnFormula(node.id);
    return formula
      ? alwaysNull(formula, columnFormula, new Set([...visited, node.id]))
      : false;
  }
  if (node.kind !== "call") return false;
  const isNull = (arg: VisualFormulaNode) =>
    alwaysNull(arg, columnFormula, visited);
  if (node.name === "if") return node.args.slice(1).every(isNull);
  if (node.name === "nullif") return isNull(node.args[0]);
  if (["coalesce", "least", "greatest"].includes(node.name))
    return node.args.every(isNull);
  return false;
}
let active = 0;
const queue: Array<() => void> = [];
async function acquire() {
  if (active < 2) {
    active++;
    return;
  }
  if (queue.length >= 8)
    throw issue(
      "Слишком много таблиц пересчитываются. Повторите через несколько секунд.",
      429,
    );
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      clearTimeout(timer);
      active++;
      resolve();
    };
    const timer = setTimeout(() => {
      const index = queue.indexOf(ready);
      if (index >= 0) queue.splice(index, 1);
      reject(
        issue("Не удалось дождаться пересчёта таблицы. Повторите запрос.", 429),
      );
    }, executionMs);
    queue.push(ready);
  });
}
function release() {
  active--;
  queue.shift()?.();
}

function decimal(value: VisualTableScalar): Decimal {
  if (value === null || !isVisualTableNumeric(value))
    throw issue(
      "Число не поддерживается без потери точности. Используйте десятичную строку.",
    );
  const parsed = new Decimal(String(value).trim());
  if (
    !parsed.isFinite() ||
    Math.max(0, parsed.e + 1) + parsed.decimalPlaces() > 38 ||
    parsed.decimalPlaces() > 38
  )
    throw issue(
      "Число превышает поддерживаемую точность DuckDB: 38 десятичных разрядов.",
    );
  return parsed;
}
function numericType(values: Iterable<VisualTableScalar>): string {
  let integers = 1,
    scale = 0;
  for (const value of values) {
    if (value === null) continue;
    const parsed = decimal(value);
    integers = Math.max(integers, parsed.e + 1);
    scale = Math.max(scale, parsed.decimalPlaces());
  }
  if (integers + scale > 38)
    throw issue(
      "Столбец содержит числа, которые нельзя совместить без потери точности.",
    );
  return `DECIMAL(${Math.max(1, integers + scale)},${scale})`;
}
function inputValue(
  value: Cell | undefined,
  column: VisualTableColumn,
): VisualTableScalar {
  if (value === undefined || value === null) return null;
  if (column.type === "number") {
    decimal(value as VisualTableScalar);
    return String(value);
  }
  if (column.type === "boolean") {
    if (typeof value !== "boolean")
      throw issue(`«${column.name}»: ожидается логическое значение.`);
    return value;
  }
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (text.length > limits.cellLength)
    throw issue(`«${column.name}»: значение превышает 10 000 символов.`);
  return text;
}
function validateInput(input: EvaluateVisualTableInput) {
  const table = visualTableSpecSchema.parse(input.table);
  const offset = input.offset ?? 0,
    limit = input.limit ?? limits.pageSize;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > limits.sourceRows ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > limits.maxPageSize
  )
    throw issue("Неверный диапазон строк таблицы.");
  if (table.sourceResultSetId) {
    const source = input.source;
    if (!source || source.result.id !== table.sourceResultSetId)
      throw issue(
        "Таблица относится к другому снимку SQL. Выберите актуальный снимок.",
      );
    const { result, rows } = source;
    if (
      !Number.isSafeInteger(result.rowCount) ||
      result.rowCount < 0 ||
      !Number.isSafeInteger(result.byteCount) ||
      result.byteCount < 0 ||
      result.rowCount > limits.sourceRows ||
      result.byteCount > limits.sourceBytes ||
      result.rowCount * result.columns.length > limits.sourceCells
    )
      throw issue(
        "Для таблицы допустимы 50 000 строк, 20 MiB и 1 000 000 ячеек. Сократите результат в SQL.",
      );
    if (table.sourceSchema !== visualTableSourceSchema(result.columns))
      throw issue("Схема снимка изменилась. Создайте таблицу для новой схемы.");
    if (
      rows.length !== result.rowCount ||
      rows.some((row) => row.length !== result.columns.length)
    )
      throw issue("Снимок неполный. Повторите исходный SQL.");
    if (new Set(result.columns.map((c) => c.id)).size !== result.columns.length)
      throw issue("В снимке повторяются идентификаторы столбцов.");
    const originalColumns = createResultVisualTable(result).columns;
    for (const column of table.columns)
      if (column.sourceColumnId) {
        const original = originalColumns.find(
          (c) => c.sourceColumnId === column.sourceColumnId,
        );
        if (!original) throw issue("Исходный столбец не найден в снимке.");
        if (original.type !== column.type)
          throw issue(
            "Тип исходного столбца нельзя менять. Добавьте вычисляемый столбец.",
          );
      }
    for (const edit of table.edits)
      if (Number(edit.rowId.slice(result.id.length + 1)) >= result.rowCount)
        throw issue(
          "Локальная правка ссылается на отсутствующую строку снимка.",
        );
  } else if (input.source)
    throw issue("Собственная таблица не должна содержать снимок SQL.");
  return { table, offset, limit };
}

function compile(
  table: VisualTableSpec,
  types: Map<string, string>,
  offset: number,
  limit: number,
) {
  const parameters: VisualTableScalar[] = [];
  const bind = (value: VisualTableScalar) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const alias = new Map(table.columns.map((c, i) => [c.id, quote(`c_${i}`)]));
  const typed = (value: VisualTableScalar, type: string) =>
    `CAST(${bind(value)} AS ${type})`;
  const numberLiteral = (value: string) => typed(value, numericType([value]));
  let compiledBytes = 0;
  const retainSql = (sql: string) => {
    compiledBytes += Buffer.byteLength(sql);
    if (compiledBytes > maxCompiledSqlBytes)
      throw issue(
        "Формулы слишком сложные: превышен допустимый размер SQL. Разделите вычисления на несколько таблиц.",
      );
    return sql;
  };
  const ctes: string[] = [];
  const addCte = (sql: string) => ctes.push(retainSql(sql));
  addCte(
    `source AS (\n  SELECT "__row_id", ${table.columns.map((c) => `CAST(${alias.get(c.id)} AS ${types.get(c.id)}) AS ${alias.get(c.id)}`).join(", ")}\n  FROM visual_source\n)`,
  );
  let current = "source",
    stage = 0;
  const precisionChecks: Array<{ source: string; expression: string }> = [];
  const checkFloatingOperands = (...expressions: string[]) => {
    for (const expression of expressions)
      precisionChecks.push({
        source: current,
        expression: retainSql(expression),
      });
  };
  const exactEditChecks: string[] = [];
  const commonTypeChecks: string[] = [];
  const canonicalNumber = (sql: string) =>
    joinSql([
      "(CASE WHEN contains(CAST(",
      sql,
      " AS VARCHAR), '.') THEN rtrim(rtrim(CAST(",
      sql,
      " AS VARCHAR), '0'), '.') ELSE CAST(",
      sql,
      " AS VARCHAR) END)",
    ]);
  // Check the common-type conversion by casting back to the operand's type.
  // This catches scale loss while treating 1e-8 and 0.00000001 as equal.
  function checkCommonType(
    args: string[],
    target: string,
    floatingOnly = false,
  ) {
    if (!args.length) return;
    const differences = args.map((arg) => {
      const roundTrip = joinSql([
        "cast_to_type(cast_to_type(",
        arg,
        ", ",
        target,
        "), ",
        arg,
        ")",
      ]);
      return joinSql([
        canonicalNumber(roundTrip),
        " IS DISTINCT FROM ",
        canonicalNumber(arg),
      ]);
    });
    const changed = joinSql(
      differences.flatMap((sql, i) => (i ? [" OR ", sql] : [sql])),
    );
    const bad = floatingOnly
      ? joinSql([
          "CASE WHEN typeof(",
          target,
          ") IN ('FLOAT', 'DOUBLE') THEN (",
          changed,
          ") ELSE FALSE END",
        ])
      : changed;
    commonTypeChecks.push(
      retainSql(
        joinSql([
          "(SELECT COALESCE(BOOL_OR(bad), FALSE) FROM (SELECT ",
          bad,
          " AS bad FROM ",
          current,
          ") coerced)",
        ]),
      ),
    );
  }
  const nonNullOverrides = new Set(
    table.edits
      .filter((edit) => edit.value !== null)
      .map((edit) => edit.columnId),
  );
  const nullExpression = (node: VisualFormulaNode) =>
    alwaysNull(node, (id) =>
      nonNullOverrides.has(id) ? undefined : formulas.get(id)?.ast,
    );
  function render(node: VisualFormulaNode, insideWindow = false): string {
    switch (node.kind) {
      case "column":
        return alias.get(node.id)!;
      case "number":
        return numberLiteral(node.value);
      case "literal":
        return bind(node.value);
      case "unary":
        return joinSql(["(", node.op, render(node.value, insideWindow), ")"]);
      case "binary": {
        const left = render(node.left, insideWindow),
          right = render(node.right, insideWindow);
        if (node.op === "/") checkFloatingOperands(left, right);
        const expression = joinSql(["(", left, " ", node.op, " ", right, ")"]);
        const comparison = ["=", "!=", "<>", "<", ">", "<=", ">="].includes(
          node.op,
        );
        checkCommonType(
          [left, right].filter(
            (_, index) => !nullExpression(index ? node.right : node.left),
          ),
          comparison
            ? joinSql(["COALESCE(", left, ", ", right, ")"])
            : expression,
          node.op === "*",
        );
        return expression;
      }
      case "call": {
        if (insideWindow && node.window)
          throw issue("Нельзя вкладывать агрегатные функции друг в друга.");
        const args = node.args.map((arg, index) => {
          if (node.name === "round" && index === 1) {
            const literal =
              arg.kind === "number"
                ? arg.value
                : arg.kind === "unary" && arg.value.kind === "number"
                  ? `${arg.op}${arg.value.value}`
                  : "";
            const precision = Number(literal);
            if (
              !literal ||
              !Number.isInteger(precision) ||
              Math.abs(precision) > 38
            )
              throw issue(
                "Точность ROUND должна быть целым числом от −38 до 38.",
              );
            return typed(precision, "INTEGER");
          }
          return render(arg, insideWindow || node.window);
        });
        if (["avg", "sqrt", "power"].includes(node.name))
          checkFloatingOperands(...args);
        const expression = joinSql([
          node.name.toUpperCase(),
          "(",
          ...args.flatMap((arg, index) => (index ? [", ", arg] : [arg])),
          ")",
          node.window ? " OVER ()" : "",
        ]);
        if (
          ["if", "coalesce", "least", "greatest", "nullif"].includes(node.name)
        ) {
          const operands = args.filter(
            (_, index) =>
              !(node.name === "if" && index === 0) &&
              !nullExpression(node.args[index]),
          );
          checkCommonType(
            operands,
            node.name === "nullif"
              ? joinSql([
                  "COALESCE(",
                  ...args.flatMap((arg, index) =>
                    index ? [", ", arg] : [arg],
                  ),
                  ")",
                ])
              : expression,
          );
        }
        return expression;
      }
    }
  }
  function applyEdits(columns: VisualTableColumn[]) {
    const replacements: string[] = [];
    for (const column of columns) {
      const edits = table.edits.filter((edit) => edit.columnId === column.id);
      if (!edits.length) continue;
      const checks: string[] = [];
      const branches = edits.map((edit) => {
        const row = bind(edit.rowId);
        const value = bind(
          column.type === "number" && edit.value !== null
            ? decimal(edit.value).toFixed()
            : edit.value,
        );
        if (column.type === "number")
          checks.push(
            retainSql(
              `WHEN "__row_id" = ${row} THEN ${canonicalNumber(`CAST(${alias.get(column.id)!} AS ${types.get(column.id)!})`)} IS DISTINCT FROM ${canonicalNumber(`CAST(${value} AS VARCHAR)`)}`,
            ),
          );
        return retainSql(
          `WHEN "__row_id" = ${row} THEN CAST(${value} AS ${types.get(column.id)!})`,
        );
      });
      replacements.push(
        joinSql([
          "CASE ",
          ...branches.flatMap((branch, i) => (i ? [" ", branch] : [branch])),
          ` ELSE ${alias.get(column.id)} END AS ${alias.get(column.id)}`,
        ]),
      );
      if (checks.length)
        exactEditChecks.push(
          retainSql(
            joinSql([
              "(SELECT COALESCE(BOOL_OR(CASE ",
              ...checks.flatMap((check, i) => (i ? [" ", check] : [check])),
              ` ELSE FALSE END), FALSE) FROM edits_${stage + 1})`,
            ]),
          ),
        );
    }
    if (!replacements.length) return;
    const next = `edits_${++stage}`;
    addCte(
      joinSql(
        [
          `${next} AS (\n  SELECT * REPLACE (`,
          ...replacements.flatMap((replacement, i) =>
            i ? [", ", replacement] : [replacement],
          ),
          `) FROM ${current}\n)`,
        ],
        maxCompiledSqlBytes,
      ),
    );
    current = next;
  }
  applyEdits(table.columns.filter((c) => !c.formula?.trim()));
  const formulas = new Map(
    table.columns
      .filter((c) => c.formula?.trim())
      .map((c) => [
        c.id,
        { column: c, ast: parseVisualTableFormula(c.formula!, table.columns) },
      ]),
  );
  const resolving = new Set<string>(),
    resolved = new Set<string>();
  function calculate(id: string) {
    if (resolved.has(id)) return;
    if (resolving.has(id))
      throw issue("Циклическая зависимость между формулами столбцов.");
    resolving.add(id);
    const { column, ast } = formulas.get(id)!;
    for (const dependency of visualFormulaDependencies(ast))
      if (formulas.has(dependency)) calculate(dependency);
    const next = `calculation_${++stage}`;
    addCte(
      `${next} AS (\n  SELECT * REPLACE (${render(ast)} AS ${alias.get(id)}) FROM ${current}\n)`,
    );
    current = next;
    applyEdits([column]);
    resolving.delete(id);
    resolved.add(id);
  }
  for (const id of formulas.keys()) calculate(id);
  const conditions = (table.filters ?? []).map((filter) => {
    const column = table.columns.find((c) => c.id === filter.columnId)!;
    const name = alias.get(column.id)!;
    if (filter.op === "isNull" || filter.op === "notNull")
      return `${name} IS ${filter.op === "notNull" ? "NOT " : ""}NULL`;
    if (filter.op === "contains")
      return `contains(lower(CAST(${name} AS VARCHAR)), lower(${bind(filter.value!)}))`;
    let value: VisualTableScalar = filter.value!;
    let sqlValue: string;
    if (column.type === "number") sqlValue = numberLiteral(String(value));
    else if (column.type === "boolean") {
      if (!["true", "false"].includes(String(value).toLowerCase()))
        throw issue("Для логического фильтра укажите true или false.");
      value = String(value).toLowerCase() === "true";
      sqlValue = typed(value, "BOOLEAN");
    } else sqlValue = bind(value);
    if (column.type === "number")
      checkCommonType([name, sqlValue], `COALESCE(${name}, ${sqlValue})`);
    return `${name} ${{ eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op]} ${sqlValue}`;
  });
  if (conditions.length) {
    addCte(
      `filtered AS (\n  SELECT * FROM ${current}\n  WHERE ${conditions.join(" AND ")}\n)`,
    );
    current = "filtered";
  }
  const prefix = joinSql(
    ["WITH\n", ...ctes.flatMap((cte, i) => (i ? [",\n", cte] : [cte])), "\n"],
    maxCompiledSqlBytes,
  );
  const order = table.sort
    ? `${alias.get(table.sort.columnId)} ${table.sort.direction.toUpperCase()} NULLS LAST, "__row_id"`
    : '"__order"';
  // Numeric original order is separate from row IDs, so UUIDs or :10 cannot change the source order.
  const rowOrder = table.sort
    ? order
    : `(SELECT "__order" FROM visual_source WHERE visual_source."__row_id" = ${current}."__row_id")`;
  const sql = `${prefix}SELECT "__row_id", ${table.columns.map((c) => `${alias.get(c.id)} AS ${quote(c.name)}`).join(", ")}\nFROM ${current}\nORDER BY ${rowOrder}\nLIMIT ${limit} OFFSET ${offset};`;
  const summaries = table.columns.filter(
    (c) => c.summary && c.summary !== "none",
  );
  const summarySql = `${prefix}SELECT COUNT(*) AS "__count"${summaries.map((c) => `, ${c.summary!.toUpperCase()}(${alias.get(c.id)}) AS ${quote(c.name)}`).join("")} FROM ${current};`;
  for (const column of summaries)
    if (column.summary === "avg") checkFloatingOperands(alias.get(column.id)!);
  // DuckDB division/AVG/SQRT/POWER use floating point. Reject operands with
  // more than 15 significant decimal digits instead of silently narrowing them.
  const risk = `(ABS(v) > 9007199254740991 OR LENGTH(TRIM(REGEXP_REPLACE(CAST(v AS VARCHAR), '[^0-9]', '', 'g'), '0')) > 15)`;
  const checks = [
    ...precisionChecks.map((check) =>
      retainSql(
        joinSql([
          `(SELECT COALESCE(BOOL_OR(${risk}), FALSE) FROM (SELECT `,
          check.expression,
          ` AS v FROM ${check.source}) precise)`,
        ]),
      ),
    ),
    ...exactEditChecks,
    ...commonTypeChecks,
  ];
  const precisionSql = checks.length
    ? joinSql(
        [
          prefix,
          "SELECT ",
          ...checks.flatMap((check, i) => (i ? [" OR ", check] : [check])),
          " AS loses_precision;",
        ],
        maxCompiledSqlBytes,
      )
    : undefined;
  joinSql([sql, summarySql, precisionSql ?? ""], maxCompiledSqlBytes);
  return { sql, summarySql, summaries, parameters, precisionSql };
}

function outputScalar(value: unknown, name: string): VisualTableScalar {
  if (typeof value === "string" && value.length > limits.cellLength)
    throw issue(`«${name}»: результат превышает 10 000 символов.`);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return value;
  throw issue(
    `«${name}»: результат нельзя представить без потери точности или он не является конечным числом.`,
  );
}
function validateResultTypes(
  reader: DuckDBResultReader,
  columns: VisualTableColumn[],
) {
  columns.forEach((column, index) => {
    const type = String(reader.columnType(index + 1));
    const numeric =
      /^(?:DECIMAL|FLOAT|DOUBLE|HUGEINT|UHUGEINT|BIGINT|UBIGINT|INTEGER|UINTEGER|SMALLINT|USMALLINT|TINYINT|UTINYINT)/.test(
        type,
      );
    if (
      ["INTEGER", '"NULL"'].includes(type) &&
      reader.getRows().every((row) => row[index + 1] === null)
    )
      return;
    if (column.type === "number" && !numeric)
      throw issue(`«${column.name}»: формула должна возвращать число.`);
    if (column.type === "boolean" && type !== "BOOLEAN")
      throw issue(
        `«${column.name}»: формула должна возвращать логическое значение.`,
      );
    if (column.type === "text" && type !== "VARCHAR")
      throw issue(`«${column.name}»: формула должна возвращать текст.`);
  });
}

export async function evaluateVisualTable(
  input: EvaluateVisualTableInput,
): Promise<VisualTableResult> {
  const start = performance.now();
  const { table, offset, limit } = validateInput(input);
  await acquire();
  let instance: DuckDBInstance | undefined,
    connection: DuckDBConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined,
    timedOut = false;
  try {
    timer = setTimeout(() => {
      timedOut = true;
      connection?.interrupt();
    }, executionMs);
    const rowCount = input.source?.result.rowCount ?? table.rows!.length;
    const sourceIndices = new Map(
      input.source?.result.columns.map((c, index) => [c.id, index]),
    );
    const valueAt = (row: number, column: VisualTableColumn) =>
      inputValue(
        input.source
          ? column.sourceColumnId === undefined
            ? null
            : input.source.rows[row][sourceIndices.get(column.sourceColumnId)!]
          : Object.hasOwn(table.rows![row].values, column.id)
            ? table.rows![row].values[column.id]
            : null,
        column,
      );
    const rowId = (row: number) =>
      table.sourceResultSetId
        ? `${table.sourceResultSetId}:${row}`
        : table.rows![row].id;
    const types = new Map<string, string>();
    for (const column of table.columns) {
      function* values() {
        for (let row = 0; row < rowCount; row++) yield valueAt(row, column);
        for (const edit of table.edits)
          if (edit.columnId === column.id) yield edit.value;
      }
      types.set(
        column.id,
        column.type === "number"
          ? numericType(values())
          : column.type === "boolean"
            ? "BOOLEAN"
            : "VARCHAR",
      );
      await yieldImmediate();
      if (timedOut)
        throw issue("Пересчёт таблицы занял слишком много времени.", 408);
    }
    const plan = compile(table, types, offset, limit);
    instance = await DuckDBInstance.create(":memory:", {
      memory_limit: "128MB",
      threads: "2",
      enable_external_access: "false",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      allow_unsigned_extensions: "false",
      max_expression_depth: "200",
    });
    connection = await instance.connect();
    if (timedOut)
      throw issue("Пересчёт таблицы занял слишком много времени.", 408);
    await connection.run(
      `CREATE TEMP TABLE visual_source ("__row_id" VARCHAR, "__order" INTEGER, ${table.columns.map((_, i) => `${quote(`c_${i}`)} VARCHAR`).join(", ")})`,
    );
    const appender = await connection.createAppender("visual_source");
    try {
      for (let row = 0; row < rowCount; row++) {
        appender.appendVarchar(rowId(row));
        appender.appendInteger(row);
        for (const column of table.columns) {
          const value = valueAt(row, column);
          if (value === null) appender.appendNull();
          else appender.appendVarchar(String(value));
        }
        appender.endRow();
        if (row % 500 === 0) {
          await yieldImmediate();
          if (timedOut)
            throw issue("Пересчёт таблицы занял слишком много времени.", 408);
        }
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
    let rowsReader: DuckDBResultReader | undefined,
      summaryReader: DuckDBResultReader | undefined;
    try {
      if (plan.precisionSql) {
        const check = await connection.runAndReadAll(
          plan.precisionSql,
          plan.parameters,
        );
        try {
          if (check.getRowsJson()[0][0])
            throw issue(
              "Вычисление или локальная правка привели бы к потере точности. Округлите исходное значение явно.",
            );
        } finally {
          check.closeSync();
        }
      }
      rowsReader = await connection.runAndReadAll(plan.sql, plan.parameters);
      validateResultTypes(rowsReader, table.columns);
      summaryReader = await connection.runAndReadAll(
        plan.summarySql,
        plan.parameters,
      );
      const rows = rowsReader.getRowsJson().map((row) => ({
        id: String(row[0]),
        values: Object.fromEntries(
          table.columns.map((column, index) => [
            column.id,
            outputScalar(row[index + 1], column.name),
          ]),
        ),
      }));
      const summary = summaryReader.getRowsJson()[0];
      const summaries = Object.fromEntries(
        plan.summaries.map((column, index) => [
          column.id,
          outputScalar(summary[index + 1], column.name),
        ]),
      );
      if (timedOut)
        throw issue("Пересчёт таблицы занял слишком много времени.", 408);
      return {
        columns: table.columns,
        rows,
        summaries,
        sourceRowCount: rowCount,
        totalRowCount: Number(summary[0]),
        offset,
        limit,
        sql: plan.sql,
        parameters: plan.parameters,
        elapsedMs: Math.round((performance.now() - start) * 10) / 10,
      };
    } finally {
      rowsReader?.closeSync();
      summaryReader?.closeSync();
    }
  } catch (error) {
    if (timedOut)
      throw issue(
        "Пересчёт таблицы занял слишком много времени. Упростите формулу.",
        408,
      );
    if (error instanceof Error && !("statusCode" in error)) {
      if (/overflow|out of range|DECIMAL[^\n]*failed/i.test(error.message))
        throw issue(
          "Вычисление выходит за поддерживаемую точность DuckDB. Уменьшите число значащих разрядов.",
        );
      throw issue(error.message);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      connection?.closeSync();
    } finally {
      try {
        instance?.closeSync();
      } finally {
        release();
      }
    }
  }
}
