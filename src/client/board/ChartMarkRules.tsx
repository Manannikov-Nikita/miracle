import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretRight,
  Trash,
} from "@phosphor-icons/react";
import type {
  ChartMarkCondition,
  ChartMarkRule,
  ChartSpec,
  Column,
} from "../../shared/types";
import {
  CHART_MARK_RULE_LIMIT,
  unfinishedPeriodRule,
} from "../../shared/chart-appearance";
import { decimal } from "../../shared/tableModel";
import { isNumericColumn } from "../../shared/column-types";
import { Select } from "../components/Select";
import ChartMarkStyleFields from "./ChartMarkStyleFields";

type SeriesOption = { name: string; colorKey: string; color: string };
type Compared = Exclude<ChartMarkCondition, { field: "position" }>;
const operators = [
  { value: "eq", label: "Равно", sign: "=" },
  { value: "ne", label: "Не равно", sign: "≠" },
  { value: "gt", label: "Больше", sign: ">" },
  { value: "gte", label: "Не меньше", sign: "≥" },
  { value: "lt", label: "Меньше", sign: "<" },
  { value: "lte", label: "Не больше", sign: "≤" },
] as const;
const positions = [
  { value: "first", label: "Первое значение" },
  { value: "last", label: "Последнее значение" },
];

function conditionType(when: Compared, spec: ChartSpec, columns: Column[]) {
  if (
    when.field === "value" ||
    (when.field === "x" && spec.kind === "histogram")
  )
    return "number";
  const column = columns.find(
    (c) => c.id === (when.field === "column" ? when.columnId : spec.x),
  );
  if (column && isNumericColumn(column)) return "number";
  if (
    column &&
    /^(?:(?:Nullable|LowCardinality)\(\s*)*(?:Bool|Boolean)(?=\s*(?:\)|$))/i.test(
      column.type,
    )
  )
    return "boolean";
  return "text";
}

function ruleTitle(
  when: ChartMarkCondition,
  spec: ChartSpec,
  columns: Column[],
) {
  if (when.field === "position")
    return positions.find((p) => p.value === when.op)!.label;
  const field =
    when.field === "column"
      ? (columns.find((c) => c.id === when.columnId)?.name ?? "Столбец")
      : when.field === "value"
        ? spec.kind === "histogram"
          ? "Частота"
          : "Значение"
        : spec.kind === "histogram"
          ? "Начало интервала"
          : (columns.find((c) => c.id === spec.x)?.name ?? "X");
  return `${field} ${operators.find((op) => op.value === when.op)?.sign} ${when.value === "" ? "«»" : when.value === null ? "NULL" : when.value}`;
}

function ConditionEditor({
  when,
  spec,
  columns,
  disabled,
  onChange,
}: {
  when: ChartMarkCondition;
  spec: ChartSpec;
  columns: Column[];
  disabled: boolean;
  onChange: (next: ChartMarkCondition) => void;
}) {
  const histogram = spec.kind === "histogram";
  const positionLabel =
    spec.kind === "sparkline" || spec.kind === "scatter"
      ? "Положение в серии"
      : "Положение на оси";
  const setCompared = (field: Compared["field"], columnId?: string) => {
    if (field === "column" && !columnId) return;
    const condition: Compared =
      field === "column"
        ? { field, columnId: columnId!, op: "eq", value: "" }
        : { field, op: "eq", value: "" };
    const type = conditionType(condition, spec, columns);
    onChange({
      ...condition,
      value: type === "number" ? 0 : type === "boolean" ? true : "",
    });
  };
  const inputType =
    when.field === "position" ? undefined : conditionType(when, spec, columns);
  const nullOp = when.field !== "position" && when.value === null;
  return (
    <>
      <label>
        Поле условия
        <Select
          aria-label="Поле условия"
          value={when.field}
          disabled={disabled}
          options={[
            { value: "value", label: histogram ? "Частота" : "Значение" },
            {
              value: "x",
              label: histogram ? "Начало интервала" : "Категория X",
            },
            { value: "position", label: positionLabel },
            ...(!histogram && columns.length
              ? [{ value: "column", label: "Столбец таблицы" }]
              : when.field === "column"
                ? [
                    {
                      value: "column",
                      label: "Столбец недоступен",
                      disabled: true,
                    },
                  ]
                : []),
          ]}
          onValueChange={(field) =>
            field === "position"
              ? onChange({ field, op: "last" })
              : setCompared(field as Compared["field"], columns[0]?.id)
          }
        />
      </label>
      {when.field === "column" && !histogram && (
        <label>
          Столбец таблицы
          <Select
            aria-label="Столбец условия"
            disabled={disabled}
            value={when.columnId}
            placeholder="Выберите столбец"
            options={columns.map((c) => ({ value: c.id, label: c.name }))}
            onValueChange={(id) => setCompared("column", id)}
          />
        </label>
      )}
      {when.field === "position" ? (
        <label>
          {spec.kind === "scatter"
            ? "Положение по координате X"
            : positionLabel}
          <Select
            aria-label={
              spec.kind === "scatter"
                ? "Положение по координате X"
                : positionLabel
            }
            disabled={disabled}
            value={when.op}
            options={positions}
            onValueChange={(op) =>
              onChange({ field: "position", op: op as "first" | "last" })
            }
          />
        </label>
      ) : (
        <>
          <label>
            Сравнение
            <Select
              aria-label="Сравнение"
              disabled={disabled}
              value={nullOp ? (when.op === "ne" ? "notNull" : "null") : when.op}
              options={[
                ...operators.filter(
                  (op) =>
                    inputType !== "boolean" ||
                    op.value === "eq" ||
                    op.value === "ne",
                ),
                ...(when.field === "column" || when.field === "x" || nullOp
                  ? [
                      { value: "null", label: "Пусто (NULL)" },
                      { value: "notNull", label: "Заполнено" },
                    ]
                  : []),
              ]}
              onValueChange={(op) => {
                if (op === "null" || op === "notNull")
                  onChange({
                    ...when,
                    op: op === "null" ? "eq" : "ne",
                    value: null,
                  });
                else
                  onChange({
                    ...when,
                    op: op as Compared["op"],
                    value:
                      when.value ??
                      (inputType === "boolean"
                        ? true
                        : inputType === "number"
                          ? 0
                          : ""),
                  });
              }}
            />
          </label>
          {!nullOp &&
            (inputType === "boolean" ? (
              <label>
                С чем сравнить
                <Select
                  aria-label="С чем сравнить"
                  disabled={disabled}
                  value={String(when.value)}
                  options={[
                    { value: "true", label: "Да (true)" },
                    { value: "false", label: "Нет (false)" },
                  ]}
                  onValueChange={(value) =>
                    onChange({ ...when, value: value === "true" })
                  }
                />
              </label>
            ) : (
              <label>
                С чем сравнить
                <ComparisonValue
                  key={`${when.field}-${when.field === "column" ? when.columnId : ""}-${inputType}`}
                  type={inputType === "number" ? "number" : "text"}
                  disabled={disabled}
                  value={String(when.value)}
                  onChange={(value) => onChange({ ...when, value })}
                />
              </label>
            ))}
        </>
      )}
    </>
  );
}

function ComparisonValue({
  type,
  value,
  disabled,
  onChange,
}: {
  type: "number" | "text";
  value: string;
  disabled: boolean;
  onChange: (next: string | number) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const invalid = type === "number" && draft !== undefined && !decimal(draft);
  return (
    <input
      aria-label="С чем сравнить"
      aria-invalid={invalid || undefined}
      inputMode={type === "number" ? "decimal" : undefined}
      maxLength={10000}
      disabled={disabled}
      value={draft ?? value}
      onBlur={() => setDraft(undefined)}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (type === "text") onChange(next);
        else {
          const parsed = decimal(next);
          if (!parsed) return;
          const number = Number(next);
          // Preserve the exact threshold for Decimal and 64-bit integer columns.
          onChange(
            Number.isFinite(number) && parsed.eq(number) ? number : next,
          );
        }
      }}
    />
  );
}

export default function ChartMarkRules({
  spec,
  columns,
  series,
  disabled,
  onChange,
}: {
  spec: ChartSpec;
  columns: Column[];
  series: SeriesOption[];
  disabled: boolean;
  onChange: (next: ChartMarkRule[] | undefined) => void;
}) {
  const rules = spec.markRules ?? [];
  const [editing, setEditing] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const show = (index: number | null) => {
    setEditing(index);
    setFilter("");
  };
  const replace = (index: number, next: ChartMarkRule) =>
    onChange(rules.map((rule, i) => (i === index ? next : rule)));
  const move = (index: number, delta: -1 | 1) => {
    const next = [...rules];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
    if (editing === index) setEditing(index + delta);
    else if (editing === index + delta) setEditing(index);
  };
  const remove = (index: number) => {
    const next = rules.filter((_, i) => i !== index);
    onChange(next.length ? next : undefined);
    if (editing !== null && editing >= index)
      show(editing === index ? null : editing - 1);
  };
  const add = (rule: ChartMarkRule) => {
    onChange([...rules, rule]);
    show(rules.length);
  };
  return (
    <div className="chart-mark-rules">
      {rules.length > 1 && (
        <p>Если совпало несколько правил, последнее задаёт общие свойства.</p>
      )}
      {rules.map((rule, index) => {
        const title = ruleTitle(rule.when, spec, columns);
        const context = `Правило ${index + 1}`;
        const active = editing === index;
        const scope = series.find((s) => s.colorKey === rule.seriesKey);
        const options = active
          ? series
              .filter((s) =>
                s.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
              )
              .slice(0, 80)
          : [];
        return (
          <div className="chart-mark-rule" key={index}>
            <div className="chart-mark-rule-head">
              <button
                type="button"
                className="chart-mark-disclosure"
                aria-label={`Редактировать · ${context}`}
                aria-expanded={active}
                onClick={() => show(active ? null : index)}
                title={title}
              >
                {active ? (
                  <CaretDown aria-hidden="true" />
                ) : (
                  <CaretRight aria-hidden="true" />
                )}
                <span>{title}</span>
              </button>
              <button
                className="chart-mark-icon"
                type="button"
                aria-label={`Выше · ${context}`}
                title="Переместить выше"
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </button>
              <button
                className="chart-mark-icon"
                type="button"
                aria-label={`Ниже · ${context}`}
                title="Переместить ниже"
                disabled={disabled || index === rules.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </button>
              <button
                className="chart-mark-icon"
                type="button"
                aria-label={`Удалить · ${context}`}
                title="Удалить правило"
                disabled={disabled}
                onClick={() => remove(index)}
              >
                <Trash aria-hidden="true" />
              </button>
            </div>
            {active && (
              <div className="chart-mark-rule-editor">
                {series.length > 80 && (
                  <input
                    aria-label="Найти серию для правила"
                    placeholder="Найти серию…"
                    value={filter}
                    disabled={disabled}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                )}
                <label>
                  Применить к
                  <Select
                    aria-label="Серия для правила"
                    disabled={disabled}
                    value={rule.seriesKey ?? ""}
                    options={[
                      { value: "", label: "Все серии" },
                      ...(rule.seriesKey &&
                      !options.some((s) => s.colorKey === rule.seriesKey)
                        ? [
                            {
                              value: rule.seriesKey,
                              label: scope?.name ?? "Сохранённая серия",
                            },
                          ]
                        : []),
                      ...options.map((s) => ({
                        value: s.colorKey,
                        label: s.name,
                      })),
                    ]}
                    onValueChange={(key) =>
                      replace(index, { ...rule, seriesKey: key || undefined })
                    }
                  />
                </label>
                <ConditionEditor
                  when={rule.when}
                  spec={spec}
                  columns={columns}
                  disabled={disabled}
                  onChange={(when) => replace(index, { ...rule, when })}
                />
                <ChartMarkStyleFields
                  includeColor
                  style={rule.style}
                  context={context}
                  baseColor={scope?.color ?? series[0]?.color ?? "#82aaff"}
                  disabled={disabled}
                  onChange={(style) => replace(index, { ...rule, style })}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className="chart-mark-add">
        <button
          type="button"
          aria-label="Добавить правило"
          disabled={disabled || rules.length >= CHART_MARK_RULE_LIMIT}
          onClick={() =>
            add({
              when: { field: "value", op: "lt", value: 0 },
              style: { color: "#ef9292" },
            })
          }
        >
          Добавить правило
        </button>
        <button
          type="button"
          aria-label="Добавить последнее значение"
          disabled={disabled || rules.length >= CHART_MARK_RULE_LIMIT}
          onClick={() => add(unfinishedPeriodRule)}
        >
          Последнее значение
        </button>
      </div>
    </div>
  );
}
