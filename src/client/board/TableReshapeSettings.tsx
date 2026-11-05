import { useEffect, useState, type ReactNode } from "react";
import type { Column } from "../../shared/types";
import type { TableAggregate, TableSpec } from "../../shared/tableTypes";
import { Select } from "../components/Select";
import { isNumericColumn } from "./model";

type Option = { value: string; label: string; disabled?: boolean };
const aggregates: Option[] = [
  { value: "sum", label: "Сумма" },
  { value: "avg", label: "Среднее" },
  { value: "min", label: "Минимум" },
  { value: "max", label: "Максимум" },
  { value: "count", label: "Количество" },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="table-setting-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function NameField({
  label,
  value,
  placeholder,
  disabled,
  change,
}: {
  label: string;
  value?: string;
  placeholder: string;
  disabled: boolean;
  change: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const commit = () => {
    const next = draft.trim() || undefined;
    if (!disabled && next !== value) change(next);
  };
  return (
    <Field label={label}>
      <input
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") setDraft(value ?? "");
        }}
      />
    </Field>
  );
}

export default function TableReshapeSettings({
  columns,
  spec,
  set,
  disabled,
}: {
  columns: Column[];
  spec: TableSpec;
  set: (patch: Partial<TableSpec>) => void;
  disabled: boolean;
}) {
  const mode = spec.reshape?.kind ?? (spec.pivot ? "aggregate" : "none");
  const options = columns.map((column, index) => ({
    value: column.id,
    label:
      columns.filter((c) => c.name === column.name).length > 1
        ? `${column.name} · ${index + 1} (${column.type})`
        : column.name,
  }));
  const sourceIds = new Set(columns.map((column) => column.id));
  const change = (patch: Partial<TableSpec>) =>
    set({ ...patch, sort: undefined });
  const changeMode = (patch: Partial<TableSpec>) =>
    set({
      ...patch,
      sort: undefined,
      columns: spec.columns
        ? Object.fromEntries(
            Object.entries(spec.columns).filter(([id]) => sourceIds.has(id)),
          )
        : undefined,
      order: spec.order?.filter((id) => sourceIds.has(id)),
    });
  const chooseMode = (next: string) => {
    if (next === mode) return;
    if (next === "none")
      return changeMode({ pivot: undefined, reshape: undefined });
    if (next === "melt") {
      const numeric = columns.filter(isNumericColumn);
      const values = numeric.length ? numeric : columns.slice(-1);
      if (!values.length) return;
      return changeMode({
        pivot: undefined,
        reshape: { kind: "melt", columns: values.map((c) => c.id) },
      });
    }
    const row =
      columns.length >= 3
        ? (columns.find((c) => !isNumericColumn(c)) ?? columns[0])
        : undefined;
    const remaining = columns.filter((c) => c.id !== row?.id);
    const category = remaining.find((c) => !isNumericColumn(c)) ?? remaining[0];
    const values = remaining.filter((c) => c.id !== category?.id);
    const value = values.find(isNumericColumn) ?? values.at(-1);
    if (!category || !value) return;
    if (next === "aggregate" && row) {
      return changeMode({
        reshape: undefined,
        pivot: {
          row: row.id,
          column: category.id,
          value: value.id,
          aggregate: isNumericColumn(value) ? "sum" : "count",
        },
      });
    }
    if (next === "pivot")
      changeMode({
        pivot: undefined,
        reshape: {
          kind: "pivot",
          rows: columns
            .filter((c) => c.id !== category.id && c.id !== value.id)
            .map((c) => c.id),
          column: category.id,
          value: value.id,
        },
      });
  };
  const pivot = spec.pivot;
  const reshape = spec.reshape;
  return (
    <div className="table-setting-section">
      <Field label="Форма таблицы">
        <Select
          aria-label="Форма таблицы"
          value={mode}
          disabled={disabled}
          onValueChange={chooseMode}
          options={[
            { value: "none", label: "Как в SQL" },
            {
              value: "aggregate",
              label: "Сводная с расчётом",
              disabled: columns.length < 3,
            },
            {
              value: "melt",
              label: "В длинную · melt",
              disabled: !columns.length,
            },
            {
              value: "pivot",
              label: "В широкую · pivot",
              disabled: columns.length < 2,
            },
          ]}
        />
      </Field>
      {reshape?.kind === "melt" && (
        <>
          <div
            className="table-reshape-columns"
            role="group"
            aria-label="Столбцы в строки"
          >
            <span>Столбцы в строки</span>
            {options.map((column) => (
              <label
                className="table-setting-check"
                key={column.value}
                title={column.label}
              >
                <input
                  type="checkbox"
                  aria-label={`В строки: ${column.label}`}
                  checked={reshape.columns.includes(column.value)}
                  disabled={
                    disabled ||
                    (reshape.columns.length === 1 &&
                      reshape.columns.includes(column.value))
                  }
                  onChange={(event) =>
                    change({
                      reshape: {
                        ...reshape,
                        columns: event.target.checked
                          ? [...reshape.columns, column.value]
                          : reshape.columns.filter((id) => id !== column.value),
                      },
                    })
                  }
                />
                <span>{column.label}</span>
              </label>
            ))}
          </div>
          <p className="table-setting-help">
            Остальные столбцы сохраняются как ключи строк. Каждое выбранное
            значение становится отдельной строкой, включая NULL.
          </p>
          <NameField
            label="Название столбца ключей"
            value={reshape.keyName}
            placeholder="Ключ"
            disabled={disabled}
            change={(keyName) => set({ reshape: { ...reshape, keyName } })}
          />
          <NameField
            label="Название столбца значений"
            value={reshape.valueName}
            placeholder="Значение"
            disabled={disabled}
            change={(valueName) => set({ reshape: { ...reshape, valueName } })}
          />
        </>
      )}
      {reshape?.kind === "pivot" && (
        <>
          <Field label="Заголовки столбцов">
            <Select
              aria-label="Заголовки столбцов"
              value={reshape.column}
              disabled={disabled}
              options={options.map((option) => ({
                ...option,
                disabled: option.value === reshape.value,
              }))}
              onValueChange={(column) =>
                change({
                  reshape: {
                    ...reshape,
                    column,
                    rows: reshape.rows.filter((id) => id !== column),
                  },
                })
              }
            />
          </Field>
          <Field label="Значения">
            <Select
              aria-label="Значения"
              value={reshape.value}
              disabled={disabled}
              options={options.map((option) => ({
                ...option,
                disabled: option.value === reshape.column,
              }))}
              onValueChange={(value) =>
                change({
                  reshape: {
                    ...reshape,
                    value,
                    rows: reshape.rows.filter((id) => id !== value),
                  },
                })
              }
            />
          </Field>
          <div
            className="table-reshape-columns"
            role="group"
            aria-label="Ключи строк"
          >
            <span>Ключи строк</span>
            {options
              .filter(
                (column) =>
                  column.value !== reshape.column &&
                  column.value !== reshape.value,
              )
              .map((column) => (
                <label
                  className="table-setting-check"
                  key={column.value}
                  title={column.label}
                >
                  <input
                    type="checkbox"
                    aria-label={`Ключ строки: ${column.label}`}
                    checked={reshape.rows.includes(column.value)}
                    disabled={disabled}
                    onChange={(event) =>
                      change({
                        reshape: {
                          ...reshape,
                          rows: event.target.checked
                            ? [...reshape.rows, column.value]
                            : reshape.rows.filter((id) => id !== column.value),
                        },
                      })
                    }
                  />
                  <span>{column.label}</span>
                </label>
              ))}
          </div>
          <p className="table-setting-help">
            Значения переносятся без расчёта. Если в одну ячейку попадают
            несколько строк, появится конфликт: добавьте ключ строки. Пустые
            пересечения — NULL.
          </p>
        </>
      )}
      {pivot && (
        <>
          <Field label="Строки сводной">
            <Select
              aria-label="Строки сводной"
              value={pivot.row}
              options={options}
              disabled={disabled}
              onValueChange={(row) => change({ pivot: { ...pivot, row } })}
            />
          </Field>
          <Field label="Столбцы сводной">
            <Select
              aria-label="Столбцы сводной"
              value={pivot.column}
              options={options}
              disabled={disabled}
              onValueChange={(column) =>
                change({ pivot: { ...pivot, column } })
              }
            />
          </Field>
          <Field label="Значение сводной">
            <Select
              aria-label="Значение сводной"
              value={pivot.value}
              options={options}
              disabled={disabled}
              onValueChange={(value) =>
                change({
                  pivot: {
                    ...pivot,
                    value,
                    aggregate: isNumericColumn(
                      columns.find((c) => c.id === value)!,
                    )
                      ? pivot.aggregate
                      : "count",
                  },
                })
              }
            />
          </Field>
          <Field label="Расчёт сводной">
            <Select
              aria-label="Расчёт сводной"
              value={pivot.aggregate}
              disabled={disabled}
              options={aggregates.map((a) => ({
                ...a,
                disabled:
                  a.value !== "count" &&
                  !columns.some(
                    (c) => c.id === pivot.value && isNumericColumn(c),
                  ),
              }))}
              onValueChange={(aggregate) =>
                change({
                  pivot: { ...pivot, aggregate: aggregate as TableAggregate },
                })
              }
            />
          </Field>
          {new Set([pivot.row, pivot.column, pivot.value]).size !== 3 && (
            <p className="table-setting-warning" role="status">
              Выберите три разных столбца: строки, столбцы и значение.
            </p>
          )}
          <p className="table-setting-help">
            Повторы объединяются выбранным расчётом. Пустые пересечения — NULL.
            Среднее: до 12 знаков после запятой.
          </p>
        </>
      )}
    </div>
  );
}
