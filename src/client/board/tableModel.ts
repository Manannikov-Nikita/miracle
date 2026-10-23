import Decimal from "decimal.js";
import type { Cell, Column } from "../../shared/types";
import type {
  TableAggregate,
  TableColor,
  TableColumnOptions,
  TableFilter,
  TableSpec,
  TableViewColumn,
  TableViewData,
} from "../../shared/tableTypes";
import { isNumericColumn } from "./model";

// SQL values can exceed IEEE-754 precision. Only bar widths become Number.
const D = Decimal.clone({
  precision: 1000,
  minE: -1000,
  maxE: 1000,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1001,
  toExpPos: 1001,
});
const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const aggregates = ["sum", "avg", "min", "max", "count"];
const colors = ["green", "yellow", "red", "blue", "purple"];
const formats = [
  "auto",
  "number",
  "compact",
  "percent",
  "percent100",
  "currency",
  "date",
  "datetime",
  "duration",
  "text",
];
const fail = (message: string): never => {
  throw new Error(`Таблица: ${message}`);
};

function decimal(value: Cell | undefined): Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!decimalPattern.test(raw) || raw.length > 10000) return null;
  const [mantissa, exponent] = raw.split(/[eE]/);
  if (
    mantissa.replace(/^[+-]/, "").replace(".", "").replace(/^0+/, "").length >
    1000
  )
    return null;
  if (
    exponent &&
    (exponent.replace(/^[+-]?0*/, "").length > 4 ||
      new D(exponent).abs().gt(1000))
  )
    return null;
  const result = new D(raw);
  if (
    !result.isFinite() ||
    (!result.isZero() && (result.e < -1000 || result.e > 1000))
  )
    return null;
  if (result.isZero() && /[1-9]/.test(mantissa)) return null;
  return result;
}
function rawText(value: Cell): string {
  return value === null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
export function tableSourceSchema(columns: Column[]): string {
  return JSON.stringify(columns.map(({ id, name, type }) => [id, name, type]));
}
export function createTableSpec(
  columns: Column[],
  visibleColumns?: string[],
): TableSpec {
  return {
    version: 1,
    sourceSchema: tableSourceSchema(columns),
    ...(visibleColumns === undefined
      ? {}
      : {
          columns: Object.fromEntries(
            columns.map((c) => [
              c.id,
              { hidden: !visibleColumns.includes(c.id) },
            ]),
          ),
        }),
  };
}

function validOptions(options: TableColumnOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options))
    fail("недопустимые настройки столбца.");
  const allowed = [
    "label",
    "hidden",
    "width",
    "align",
    "format",
    "decimals",
    "currency",
    "prefix",
    "suffix",
    "nullText",
    "display",
    "thresholds",
    "mappings",
    "summary",
  ];
  if (Object.keys(options).some((k) => !allowed.includes(k)))
    fail("неизвестная настройка столбца.");
  for (const key of ["label", "prefix", "suffix", "nullText"] as const)
    if (options[key] !== undefined && typeof options[key] !== "string")
      fail(`недопустимое значение ${key}.`);
  if (options.hidden !== undefined && typeof options.hidden !== "boolean")
    fail("недопустимая видимость столбца.");
  if (
    options.width !== undefined &&
    (!Number.isFinite(options.width) ||
      options.width < 40 ||
      options.width > 2000)
  )
    fail("ширина столбца должна быть от 40 до 2000.");
  if (
    options.align !== undefined &&
    !["left", "center", "right"].includes(options.align)
  )
    fail("недопустимое выравнивание.");
  if (options.format !== undefined && !formats.includes(options.format))
    fail("неизвестный формат.");
  if (
    options.decimals !== undefined &&
    (!Number.isInteger(options.decimals) ||
      options.decimals < 0 ||
      options.decimals > 12)
  )
    fail("точность должна быть от 0 до 12.");
  if (
    options.currency !== undefined &&
    !["RUB", "USD", "EUR"].includes(options.currency)
  )
    fail("неизвестная валюта.");
  if (
    options.display !== undefined &&
    !["auto", "color-text", "color-background", "bar"].includes(options.display)
  )
    fail("неизвестный вид ячейки.");
  if (
    options.summary !== undefined &&
    options.summary !== "none" &&
    !aggregates.includes(options.summary)
  )
    fail("неизвестный итог.");
  if (
    options.thresholds !== undefined &&
    (!Array.isArray(options.thresholds) ||
      options.thresholds.some(
        (t) => !t || !decimal(t.value) || !colors.includes(t.color),
      ))
  )
    fail("порог должен содержать число и цвет.");
  if (
    options.mappings !== undefined &&
    (!Array.isArray(options.mappings) ||
      options.mappings.some(
        (m) =>
          !m ||
          (m.value !== null && typeof m.value !== "string") ||
          typeof m.text !== "string" ||
          (m.color !== undefined && !colors.includes(m.color)),
      ))
  )
    fail("недопустимая замена значения.");
}
function sourceColumn(columns: Column[], id: string): Column {
  return (
    columns.find((c) => c.id === id) ??
    fail(`столбец «${id}» отсутствует в источнике.`)
  );
}
function validateSpec(columns: Column[], spec: TableSpec): void {
  if (!spec || spec.version !== 1) fail("неподдерживаемая версия настроек.");
  if (spec.sourceSchema !== tableSourceSchema(columns))
    fail("схема результата изменилась. Сбросьте настройки таблицы.");
  if (new Set(columns.map((c) => c.id)).size !== columns.length)
    fail("идентификаторы столбцов должны быть уникальными.");
  if (
    spec.columns !== undefined &&
    (!spec.columns ||
      typeof spec.columns !== "object" ||
      Array.isArray(spec.columns))
  )
    fail("недопустимые настройки столбцов.");
  for (const [id, options] of Object.entries(spec.columns ?? {})) {
    validOptions(options);
    const source = columns.find((c) => c.id === id);
    if (
      source &&
      options.summary &&
      !["none", "count"].includes(options.summary) &&
      !isNumericColumn(source)
    )
      fail(`«${source.name}»: для итога выберите числовой столбец.`);
  }
  if (
    spec.order !== undefined &&
    (!Array.isArray(spec.order) ||
      spec.order.some((id) => typeof id !== "string") ||
      new Set(spec.order).size !== spec.order.length)
  )
    fail("недопустимый порядок столбцов.");
  if (
    spec.density !== undefined &&
    !["compact", "comfortable"].includes(spec.density)
  )
    fail("неизвестная плотность строк.");
  if (
    spec.frozenColumns !== undefined &&
    (!Number.isInteger(spec.frozenColumns) ||
      spec.frozenColumns < 0 ||
      spec.frozenColumns > 200)
  )
    fail("недопустимое число закреплённых столбцов.");
  if (spec.wrap !== undefined && typeof spec.wrap !== "boolean")
    fail("недопустимый перенос строк.");
  if (spec.filters !== undefined && !Array.isArray(spec.filters))
    fail("недопустимые фильтры.");
  for (const filter of spec.filters ?? []) {
    if (
      !filter ||
      ![
        "contains",
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
        "isNull",
        "notNull",
      ].includes(filter.op)
    )
      fail("неизвестный фильтр.");
    const column = sourceColumn(columns, filter.column);
    if (
      !["isNull", "notNull"].includes(filter.op) &&
      typeof filter.value !== "string"
    )
      fail("задайте значение фильтра.");
    if (
      isNumericColumn(column) &&
      !["isNull", "notNull", "contains"].includes(filter.op) &&
      !decimal(filter.value)
    )
      fail("значение числового фильтра должно быть числом.");
  }
  if (spec.pivot) {
    const p = spec.pivot;
    sourceColumn(columns, p.row);
    sourceColumn(columns, p.column);
    const value = sourceColumn(columns, p.value);
    if (p.row === p.column)
      fail("строка и столбец сводной таблицы должны различаться.");
    if (!aggregates.includes(p.aggregate))
      fail("неизвестная агрегация сводной таблицы.");
    if (p.aggregate !== "count" && !isNumericColumn(value))
      fail("для агрегации выберите числовой столбец.");
  }
  if (
    spec.sort &&
    (!["asc", "desc"].includes(spec.sort.direction) ||
      typeof spec.sort.column !== "string")
  )
    fail("недопустимая сортировка.");
}
function matches(value: Cell, column: Column, filter: TableFilter): boolean {
  if (filter.op === "isNull") return value === null;
  if (filter.op === "notNull") return value !== null;
  if (filter.op === "contains")
    return (
      value !== null &&
      rawText(value)
        .toLocaleLowerCase()
        .includes(filter.value!.toLocaleLowerCase())
    );
  if (value === null) return filter.op === "neq";
  let comparison: number;
  if (isNumericColumn(column))
    comparison = (
      decimal(value) ?? fail(`«${column.name}»: недопустимое число.`)
    ).cmp(decimal(filter.value)!);
  else {
    const left = rawText(value),
      right = filter.value!;
    comparison = left === right ? 0 : left < right ? -1 : 1;
  }
  switch (filter.op) {
    case "eq":
      return comparison === 0;
    case "neq":
      return comparison !== 0;
    case "gt":
      return comparison > 0;
    case "gte":
      return comparison >= 0;
    case "lt":
      return comparison < 0;
    case "lte":
      return comparison <= 0;
  }
}
interface Accumulator {
  count: number;
  numericCount: number;
  sum: Decimal;
  min: Decimal | null;
  max: Decimal | null;
}
const accumulator = (): Accumulator => ({
  count: 0,
  numericCount: 0,
  sum: new D(0),
  min: null,
  max: null,
});
function accumulate(
  state: Accumulator,
  value: Cell,
  aggregate: TableAggregate,
): void {
  state.count++;
  if (aggregate === "count" || value === null) return;
  const number =
    decimal(value) ??
    fail("значение для числового итога не является допустимым числом.");
  state.numericCount++;
  if (aggregate === "sum" || aggregate === "avg") {
    const sum = state.sum.plus(number);
    if (!sum.isFinite()) fail("числовой итог выходит за допустимый диапазон.");
    // Reversibility detects loss of low-order digits at the precision boundary.
    if (!sum.minus(state.sum).eq(number) || !sum.minus(number).eq(state.sum))
      fail("числовой итог превышает точность в 1000 значащих цифр.");
    state.sum = sum;
  }
  if (state.min === null || number.lt(state.min)) state.min = number;
  if (state.max === null || number.gt(state.max)) state.max = number;
}
function finish(state: Accumulator, aggregate: TableAggregate): Cell {
  if (aggregate === "count") return state.count;
  if (!state.numericCount) return null;
  switch (aggregate) {
    case "sum":
      return state.sum.toString();
    // Repeating averages have an explicit twelve-decimal rounding boundary.
    case "avg": {
      const average = state.sum.div(state.numericCount);
      // A huge integer part can exhaust significant precision before the
      // promised twelve fractional places. Exact integer division remains safe.
      if (average.e + 13 > 1000 && !state.sum.mod(state.numericCount).isZero())
        fail("среднее превышает точность для округления до 12 знаков.");
      return average.toDecimalPlaces(12).toString();
    }
    case "min":
      return state.min!.toString();
    case "max":
      return state.max!.toString();
  }
}
function typedKey(value: Cell): string {
  if (value === null) return '["null"]';
  if (Array.isArray(value))
    return JSON.stringify(["array", value.map(typedKey)]);
  if (typeof value === "object")
    return JSON.stringify([
      "object",
      Object.keys(value)
        .sort()
        .map((key) => [key, typedKey(value[key])]),
    ]);
  return JSON.stringify([typeof value, value]);
}
function pivotTable(
  columns: Column[],
  rows: Cell[][],
  spec: TableSpec,
): { columns: TableViewColumn[]; rows: Cell[][] } {
  const p = spec.pivot!;
  const rowIndex = columns.findIndex((c) => c.id === p.row),
    keyIndex = columns.findIndex((c) => c.id === p.column),
    valueIndex = columns.findIndex((c) => c.id === p.value);
  const pivotKeys = new Map<string, Cell>(),
    groups = new Map<
      string,
      { label: Cell; values: Map<string, Accumulator> }
    >();
  for (const row of rows) {
    const rowValue = row[rowIndex] ?? null,
      keyValue = row[keyIndex] ?? null,
      rowKey = typedKey(rowValue),
      key = typedKey(keyValue);
    if (key.length + 6 > 10000 || rowKey.length > 10000)
      fail("ключ сводной таблицы слишком длинный (максимум 10000 символов).");
    if (!pivotKeys.has(key)) {
      pivotKeys.set(key, keyValue);
      if (pivotKeys.size > 200)
        fail("сводная таблица поддерживает максимум 200 столбцов значений.");
    }
    let group = groups.get(rowKey);
    if (!group) {
      group = { label: rowValue, values: new Map() };
      groups.set(rowKey, group);
    }
    if (groups.size * (pivotKeys.size + 1) > 1_000_000)
      fail("сводная таблица превышает 1 000 000 ячеек.");
    let state = group.values.get(key);
    if (!state) {
      state = accumulator();
      group.values.set(key, state);
    }
    accumulate(state, row[valueIndex] ?? null, p.aggregate);
  }
  const rowColumn = columns[rowIndex],
    valueColumn = columns[valueIndex];
  const { label: _label, ...inherited } = spec.columns?.[p.value] ?? {};
  const outputColumns: TableViewColumn[] = [
    {
      ...rowColumn,
      sourceId: rowColumn.id,
      options: spec.columns?.[rowColumn.id] ?? {},
    },
  ];
  for (const [key, caption] of pivotKeys) {
    const id = `pivot:${key}`;
    outputColumns.push({
      id,
      name: caption === null ? "NULL" : rawText(caption),
      type: p.aggregate === "count" ? "UInt64" : "Decimal",
      sourceId: valueColumn.id,
      options: { ...inherited, ...spec.columns?.[id] },
    });
  }
  return {
    columns: outputColumns,
    rows: Array.from(groups.values(), (group) => [
      group.label,
      ...Array.from(pivotKeys.keys(), (key) => {
        const state = group.values.get(key);
        return state ? finish(state, p.aggregate) : null;
      }),
    ]),
  };
}
export function buildTable(
  columns: Column[],
  rows: Cell[][],
  spec: TableSpec,
): TableViewData {
  validateSpec(columns, spec);
  if (rows.length * columns.length > 1_000_000)
    fail("источник превышает 1 000 000 ячеек.");
  const filterIndexes = (spec.filters ?? []).map((filter) => ({
    filter,
    index: columns.findIndex((c) => c.id === filter.column),
  }));
  const filtered = rows.filter((row) =>
    filterIndexes.every(({ filter, index }) =>
      matches(row[index] ?? null, columns[index], filter),
    ),
  );
  const transformed = spec.pivot
    ? pivotTable(columns, filtered, spec)
    : {
        columns: columns.map((c) => ({
          ...c,
          sourceId: c.id,
          options: spec.columns?.[c.id] ?? {},
        })),
        rows: filtered.map((row) => columns.map((_, i) => row[i] ?? null)),
      };
  const validReference = (id: string) =>
    columns.some((c) => c.id === id) ||
    transformed.columns.some((c) => c.id === id) ||
    (!!spec.pivot && id.startsWith("pivot:") && id.length <= 10000);
  for (const id of [...Object.keys(spec.columns ?? {}), ...(spec.order ?? [])])
    if (!validReference(id)) fail(`неизвестный столбец «${id}» в настройках.`);
  if (spec.sort) {
    const { column: id, direction } = spec.sort,
      index = transformed.columns.findIndex((c) => c.id === id);
    if (
      index < 0 &&
      !(spec.pivot && id.startsWith("pivot:") && validReference(id))
    )
      fail(`столбец сортировки «${id}» отсутствует после преобразования.`);
    if (index >= 0) {
      const column = transformed.columns[index],
        sign = direction === "asc" ? 1 : -1;
      transformed.rows = transformed.rows
        .map((row, original) => ({ row, original }))
        .sort((a, b) => {
          const left = a.row[index],
            right = b.row[index];
          if (left === null || right === null)
            return left === right
              ? a.original - b.original
              : left === null
                ? 1
                : -1;
          let comparison: number;
          if (isNumericColumn(column))
            comparison = (
              decimal(left) ?? fail(`«${column.name}»: недопустимое число.`)
            ).cmp(
              decimal(right) ?? fail(`«${column.name}»: недопустимое число.`),
            );
          else {
            const l = rawText(left),
              r = rawText(right);
            comparison = l === r ? 0 : l < r ? -1 : 1;
          }
          return comparison * sign || a.original - b.original;
        })
        .map(({ row }) => row);
    }
  }
  const ranked = new Map((spec.order ?? []).map((id, i) => [id, i]));
  const selected = transformed.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !column.options.hidden)
    .sort(
      (a, b) =>
        (ranked.get(a.column.id) ?? Number.MAX_SAFE_INTEGER) -
          (ranked.get(b.column.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    );
  const summaries: Record<string, Cell> = Object.create(null),
    ranges: Record<string, { min: string; max: string }> = Object.create(null);
  for (const { column, index } of selected) {
    const summary = column.options.summary;
    if (summary && summary !== "none") {
      if (summary !== "count" && !isNumericColumn(column))
        fail(`«${column.name}»: для итога выберите числовой столбец.`);
      const state = accumulator();
      for (const row of transformed.rows)
        accumulate(state, row[index], summary);
      summaries[column.id] = finish(state, summary);
    }
    if (isNumericColumn(column)) {
      let min: Decimal | null = null,
        max: Decimal | null = null;
      for (const row of transformed.rows) {
        const number = decimal(row[index]);
        if (!number) continue;
        if (!min || number.lt(min)) min = number;
        if (!max || number.gt(max)) max = number;
      }
      if (min && max)
        ranges[column.id] = { min: min.toString(), max: max.toString() };
    }
  }
  return {
    columns: selected.map(({ column }) => column),
    rows: transformed.rows.map((row) =>
      selected.map(({ index }) => row[index]),
    ),
    sourceRowCount: rows.length,
    filteredRowCount: filtered.length,
    summaries,
    ranges,
  };
}
function grouped(number: Decimal, decimals?: number): string {
  if (!number.isFinite()) throw new Error("Число вне диапазона формата");
  const [integer, fraction] = (
    decimals === undefined ? number.toFixed() : number.toFixed(decimals)
  ).split(".");
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction === undefined ? "" : `.${fraction}`)
  );
}
function numericFormat(number: Decimal, options: TableColumnOptions): string {
  const precision = options.decimals;
  switch (options.format) {
    case "number":
      return grouped(number, precision);
    case "percent":
      return `${grouped(number.times(100), precision)}%`;
    case "percent100":
      return `${grouped(number, precision)}%`;
    case "currency":
      return `${{ RUB: "₽", USD: "$", EUR: "€" }[options.currency ?? "RUB"]}${grouped(number, precision ?? 2)}`;
    case "compact": {
      const scales = [
        ["1000000000000", "T"],
        ["1000000000", "B"],
        ["1000000", "M"],
        ["1000", "k"],
      ] as const;
      const scale = scales.find(([base]) => number.abs().gte(base));
      if (!scale) return grouped(number, precision);
      const scaled = number.div(scale[0]);
      return `${precision === undefined ? scaled.toDecimalPlaces(1).toString() : scaled.toFixed(precision)}${scale[1]}`;
    }
    case "duration": {
      const rounded = number.abs().toDecimalPlaces(precision ?? 0),
        hours = rounded.div(3600).floor().toFixed(0),
        minutes = rounded.div(60).floor().mod(60).toFixed(0).padStart(2, "0"),
        seconds = rounded
          .mod(60)
          .toFixed(precision ?? 0)
          .padStart(precision ? precision + 3 : 2, "0");
      return `${number.isNegative() ? "-" : ""}${hours}:${minutes}:${seconds}`;
    }
    default:
      return number.toString();
  }
}
export function formatTableCell(
  value: Cell,
  _column: Column,
  options: TableColumnOptions,
): { text: string; color?: TableColor } {
  const raw = rawText(value),
    mapping = options.mappings?.find((m) =>
      value === null ? m.value === null : m.value !== null && m.value === raw,
    );
  if (mapping)
    return {
      text: mapping.text,
      ...(mapping.color ? { color: mapping.color } : {}),
    };
  if (value === null) return { text: options.nullText ?? "—" };
  let text = raw;
  let color: TableColor | undefined;
  try {
    const number = decimal(value);
    if (number) {
      const thresholds = (options.thresholds ?? [])
        .map((t) => ({ ...t, number: decimal(t.value) }))
        .filter((t) => t.number !== null)
        .sort((a, b) => a.number!.cmp(b.number!));
      for (const threshold of thresholds)
        if (number.gte(threshold.number!)) color = threshold.color;
      if (
        options.format &&
        !["auto", "text", "date", "datetime"].includes(options.format)
      )
        text = numericFormat(number, options);
    }
    if (
      (options.format === "date" || options.format === "datetime") &&
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(
        value,
      )
    ) {
      const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
      // Date.parse rolls February 30 into March; reject that normalization.
      if (
        !Number.isNaN(calendar.getTime()) &&
        calendar.toISOString().slice(0, 10) === value.slice(0, 10)
      ) {
        // SQL timestamps have no offset: the table's explicit presentation policy is UTC.
        const input = value.includes(" ") ? value.replace(" ", "T") : value;
        const utc =
          input.length > 10 && !/(?:Z|[+-]\d{2}:\d{2})$/.test(input)
            ? `${input}Z`
            : input;
        const date = new Date(utc);
        if (!Number.isNaN(date.getTime())) {
          const iso = date.toISOString();
          text =
            options.format === "date"
              ? iso.slice(0, 10)
              : `${iso.slice(0, 19).replace("T", " ")} UTC`;
        }
      }
    }
  } catch {
    text = raw;
  }
  return {
    text: `${options.prefix ?? ""}${text}${options.suffix ?? ""}`,
    ...(color ? { color } : {}),
  };
}
export function tableBarPercent(
  value: Cell,
  range: { min: string; max: string },
): number {
  const number = decimal(value),
    min = decimal(range.min),
    max = decimal(range.max);
  if (!number || !min || !max || max.lt(min)) return 0;
  if (max.eq(min)) return number.gte(max) ? 100 : 0;
  return D.max(
    0,
    D.min(100, number.minus(min).div(max.minus(min)).times(100)),
  ).toNumber();
}
