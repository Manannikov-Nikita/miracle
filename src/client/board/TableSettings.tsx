import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash } from "@phosphor-icons/react";
import type { Column, ResultSet } from "../../shared/types";
import type {
  TableAggregate,
  TableColor,
  TableColumnOptions,
  TableFilter,
  TableFormat,
  TableSpec,
} from "../../shared/tableTypes";
import {
  createTableSpec,
  tableReshapeIds,
  tableSourceSchema,
} from "./tableModel";
import { Select } from "../components/Select";
import { isNumericColumn } from "./model";
import { TableMappingColor, TableMappingSource } from "./TableMappingControls";
import TableReshapeSettings from "./TableReshapeSettings";
import "./table-settings.css";

type Option = { value: string; label: string; disabled?: boolean };
const formats: Option[] = [
  ["auto", "Авто"],
  ["number", "Число"],
  ["compact", "Компактно · 34.1k"],
  ["percent", "Процент · 0,12 → 12%"],
  ["percent100", "Процент · 12 → 12%"],
  ["currency", "Валюта"],
  ["date", "Дата"],
  ["datetime", "Дата и время · UTC"],
  ["duration", "Длительность · секунды"],
  ["text", "Текст"],
].map(([value, label]) => ({ value, label }));
const colors: Option[] = [
  ["green", "Зелёный"],
  ["yellow", "Жёлтый"],
  ["red", "Красный"],
  ["blue", "Синий"],
  ["purple", "Фиолетовый"],
].map(([value, label]) => ({ value, label }));
const aggregates: Option[] = [
  ["sum", "Сумма"],
  ["avg", "Среднее"],
  ["min", "Минимум"],
  ["max", "Максимум"],
  ["count", "Количество"],
].map(([value, label]) => ({ value, label }));
const operators: Option[] = [
  ["contains", "Содержит"],
  ["eq", "Равно"],
  ["neq", "Не равно"],
  ["gt", "Больше"],
  ["gte", "Больше или равно"],
  ["lt", "Меньше"],
  ["lte", "Меньше или равно"],
  ["isNull", "NULL"],
  ["notNull", "Не NULL"],
].map(([value, label]) => ({ value, label }));
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="table-setting-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Choice({
  label,
  value,
  options,
  disabled,
  change,
  placeholder,
}: {
  label: string;
  value: string;
  options: Option[];
  disabled: boolean;
  change: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <Select
        aria-label={label}
        value={value}
        placeholder={placeholder}
        options={options}
        disabled={disabled}
        onValueChange={change}
      />
    </Field>
  );
}
// Commit on blur/Enter so an empty or incomplete numerical draft never reaches persisted state.
function Draft({
  label,
  value,
  change,
  disabled,
  numeric,
  min,
  max,
  integer = false,
  allowEmpty = true,
  placeholder,
  maxLength = 200,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  disabled: boolean;
  numeric?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  allowEmpty?: boolean;
  placeholder?: string;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(value);
    setInvalid(false);
  }, [value]);
  const commit = () => {
    if (disabled || draft === value) return;
    const next = numeric ? draft.trim() : draft;
    const number = Number(next);
    if (
      numeric &&
      ((next === "" && !allowEmpty) ||
        (next !== "" &&
          (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(next) ||
            !Number.isFinite(number) ||
            (integer && !Number.isInteger(number)) ||
            (min !== undefined && number < min) ||
            (max !== undefined && number > max))))
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    change(next);
  };
  return (
    <Field label={label}>
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={draft}
        inputMode={numeric ? "decimal" : undefined}
        placeholder={placeholder}
        maxLength={numeric ? 100 : maxLength}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setDraft(value);
            setInvalid(false);
          }
        }}
      />
      {invalid && (
        <span className="table-setting-error" role="alert">
          {integer ? "Целое число" : "Число"}
          {min !== undefined ? ` от ${min}` : ""}
          {max !== undefined ? ` до ${max}` : ""}
        </span>
      )}
    </Field>
  );
}
function columnOptions(columns: Column[]): Option[] {
  return columns.map((column, index) => ({
    value: column.id,
    label:
      columns.filter((c) => c.name === column.name).length > 1
        ? `${column.name} · ${index + 1} (${column.type})`
        : column.name,
  }));
}
function ConditionalSettings({
  options,
  set,
  disabled,
}: {
  options: TableColumnOptions;
  set: (patch: Partial<TableColumnOptions>) => void;
  disabled: boolean;
}) {
  const thresholds = options.thresholds ?? [];
  // Keep the legacy fallback last: explicit NULL mappings take precedence.
  const mappings: NonNullable<TableColumnOptions["mappings"]> = [
    ...(options.mappings ?? []),
    ...(options.nullText !== undefined
      ? [{ value: null, text: options.nullText }]
      : []),
  ];
  const setMappings = (next: NonNullable<TableColumnOptions["mappings"]>) => {
    if (next.length > 20) {
      // A legacy column may already have twenty rules plus its NULL fallback.
      // Keep that fallback editable without exceeding the persisted rule limit.
      set({ mappings: next.slice(0, -1), nullText: next.at(-1)!.text });
    } else {
      set({ mappings: next, nullText: undefined });
    }
  };
  return (
    <>
      <details className="table-setting-details">
        <summary>
          Условное оформление
          {thresholds.length ? ` · ${thresholds.length}` : ""}
        </summary>
        <Choice
          label="Оформление ячейки"
          disabled={disabled}
          value={options.display ?? "auto"}
          change={(display) =>
            set({ display: display as TableColumnOptions["display"] })
          }
          options={[
            { value: "auto", label: "Обычный текст" },
            { value: "color-text", label: "Цвет текста" },
            { value: "color-background", label: "Цвет фона" },
            { value: "bar", label: "Полоса значения" },
          ]}
        />
        <p className="table-setting-help">
          Порог действует от указанного значения. Цвет виден в выбранном
          оформлении.
        </p>
        {thresholds.map((threshold, index) => (
          <div className="table-setting-rule" key={index}>
            <div className="table-setting-rule-heading">
              <span>Порог {index + 1}</span>
              <button
                type="button"
                className="table-setting-remove"
                disabled={disabled}
                aria-label={`Удалить порог ${index + 1}`}
                title={`Удалить порог ${index + 1}`}
                onClick={() =>
                  set({ thresholds: thresholds.filter((_, i) => i !== index) })
                }
              >
                <Trash size={16} aria-hidden="true" />
              </button>
            </div>
            <Draft
              label={`Порог ${index + 1} · от`}
              value={threshold.value}
              allowEmpty={false}
              numeric
              disabled={disabled}
              change={(value) =>
                set({
                  thresholds: thresholds.map((t, i) =>
                    i === index ? { ...t, value } : t,
                  ),
                })
              }
            />
            <Choice
              label={`Цвет порога ${index + 1}`}
              value={threshold.color}
              options={colors}
              disabled={disabled}
              change={(color) =>
                set({
                  thresholds: thresholds.map((t, i) =>
                    i === index ? { ...t, color: color as TableColor } : t,
                  ),
                })
              }
            />
          </div>
        ))}
        <button
          type="button"
          disabled={disabled || thresholds.length >= 12}
          onClick={() =>
            set({ thresholds: [...thresholds, { value: "0", color: "green" }] })
          }
        >
          <Plus size={16} aria-hidden="true" /> Порог
        </button>
      </details>
      <details className="table-setting-details">
        <summary>
          Подстановка значений{mappings.length ? ` · ${mappings.length}` : ""}
        </summary>
        <p className="table-setting-help">
          Заменяет отображение точного значения. Исходные данные сохраняются.
        </p>
        {mappings.map((mapping, index) => (
          <div
            className="table-setting-rule"
            key={index}
            role="group"
            aria-label={`Подстановка ${index + 1}`}
          >
            <div className="table-setting-rule-heading">
              <span>Подстановка {index + 1}</span>
              <TableMappingColor
                value={mapping.color}
                disabled={
                  disabled ||
                  (mappings.length > 20 && index === mappings.length - 1)
                }
                onChange={(color) =>
                  setMappings(
                    mappings.map((m, i) => (i === index ? { ...m, color } : m)),
                  )
                }
              />
              <button
                type="button"
                className="table-setting-remove"
                disabled={disabled}
                aria-label={`Удалить подстановку ${index + 1}`}
                title={`Удалить подстановку ${index + 1}`}
                onClick={() =>
                  setMappings(mappings.filter((_, i) => i !== index))
                }
              >
                <Trash size={16} aria-hidden="true" />
              </button>
            </div>
            <TableMappingSource
              value={mapping.value}
              disabled={
                disabled ||
                (mappings.length > 20 && index === mappings.length - 1)
              }
              onChange={(value) =>
                setMappings(
                  mappings.map((m, i) => (i === index ? { ...m, value } : m)),
                )
              }
            />
            <Draft
              label="Отображать вместо значения"
              value={mapping.text}
              disabled={disabled}
              change={(text) =>
                setMappings(
                  mappings.map((m, i) => (i === index ? { ...m, text } : m)),
                )
              }
            />
            {mappings.length > 20 && index === mappings.length - 1 && (
              <p className="table-setting-help">
                Чтобы изменить исходное значение или цвет, удалите одну
                подстановку.
              </p>
            )}
          </div>
        ))}
        <button
          type="button"
          disabled={disabled || mappings.length >= 20}
          onClick={() => setMappings([...mappings, { value: null, text: "" }])}
        >
          <Plus size={16} aria-hidden="true" /> Подстановка
        </button>
      </details>
    </>
  );
}
function ColumnSettings({
  result,
  spec,
  set,
  disabled,
}: {
  result: ResultSet;
  spec: TableSpec;
  set: (patch: Partial<TableSpec>) => void;
  disabled: boolean;
}) {
  const [selected, select] = useState(result.columns[0]?.id ?? "");
  const id = result.columns.some((c) => c.id === selected)
    ? selected
    : (result.columns[0]?.id ?? "");
  const column = result.columns.find((c) => c.id === id);
  if (!column)
    return <p className="table-setting-help">В снимке нет столбцов.</p>;
  const options = spec.columns?.[id] ?? {};
  const change = (patch: Partial<TableColumnOptions>) =>
    set({ columns: { ...spec.columns, [id]: { ...options, ...patch } } });
  const order = [
    ...(spec.order ?? []).filter((key) =>
      result.columns.some((c) => c.id === key),
    ),
    ...result.columns
      .map((c) => c.id)
      .filter((key) => !spec.order?.includes(key)),
  ];
  const position = order.indexOf(id);
  const move = (delta: number) => {
    const next = [...order];
    [next[position], next[position + delta]] = [
      next[position + delta],
      next[position],
    ];
    set({ order: next });
  };
  return (
    <>
      <Choice
        label="Столбец"
        value={id}
        options={columnOptions(result.columns)}
        disabled={false}
        change={select}
      />
      <div key={id} className="table-settings-stack">
        <div className="table-setting-order">
          <label className="table-setting-check">
            <input
              type="checkbox"
              disabled={disabled}
              checked={options.hidden ?? false}
              onChange={(e) => change({ hidden: e.target.checked })}
            />
            Скрыть
          </label>
          <span>
            {position + 1} / {order.length}
          </span>
          <button
            type="button"
            disabled={disabled || position <= 0}
            aria-label="Переместить столбец влево"
            title="Переместить столбец влево"
            onClick={() => move(-1)}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={disabled || position >= order.length - 1}
            aria-label="Переместить столбец вправо"
            title="Переместить столбец вправо"
            onClick={() => move(1)}
          >
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        <Draft
          label="Название столбца"
          value={options.label ?? ""}
          placeholder={column.name}
          disabled={disabled}
          change={(label) => change({ label: label || undefined })}
        />
        <div className="table-settings-grid">
          <Draft
            label="Ширина · px"
            value={options.width?.toString() ?? ""}
            placeholder="Авто"
            numeric
            integer
            min={80}
            max={800}
            disabled={disabled}
            change={(width) =>
              change({ width: width ? Number(width) : undefined })
            }
          />
          <Choice
            label="Выравнивание"
            value={options.align ?? ""}
            options={[
              { value: "", label: "Авто" },
              { value: "left", label: "Слева" },
              { value: "center", label: "По центру" },
              { value: "right", label: "Справа" },
            ]}
            disabled={disabled}
            change={(align) =>
              change({
                align: (align || undefined) as TableColumnOptions["align"],
              })
            }
          />
        </div>
        <Choice
          label="Формат"
          value={options.format ?? "auto"}
          options={formats}
          disabled={disabled}
          change={(format) => change({ format: format as TableFormat })}
        />
        <Choice
          label="Знаков после запятой"
          value={options.decimals?.toString() ?? ""}
          options={[
            { value: "", label: "Авто" },
            ...Array.from({ length: 13 }, (_, i) => ({
              value: String(i),
              label: String(i),
            })),
          ]}
          disabled={disabled}
          change={(decimals) =>
            change({ decimals: decimals === "" ? undefined : Number(decimals) })
          }
        />
        {options.format === "currency" && (
          <Choice
            label="Валюта"
            value={options.currency ?? "RUB"}
            disabled={disabled}
            options={[
              { value: "RUB", label: "₽ · RUB" },
              { value: "USD", label: "$ · USD" },
              { value: "EUR", label: "€ · EUR" },
            ]}
            change={(currency) =>
              change({ currency: currency as TableColumnOptions["currency"] })
            }
          />
        )}
        <div className="table-settings-grid">
          <Draft
            label="Перед значением"
            maxLength={100}
            value={options.prefix ?? ""}
            disabled={disabled}
            change={(prefix) => change({ prefix })}
          />
          <Draft
            label="После значения"
            maxLength={100}
            value={options.suffix ?? ""}
            disabled={disabled}
            change={(suffix) => change({ suffix })}
          />
        </div>
        <Choice
          label="Итог столбца"
          value={options.summary ?? "none"}
          options={[
            { value: "none", label: "Нет" },
            ...aggregates.map((a) => ({
              ...a,
              disabled: !isNumericColumn(column) && a.value !== "count",
            })),
          ]}
          disabled={disabled}
          change={(summary) =>
            change({ summary: summary as TableColumnOptions["summary"] })
          }
        />
        <ConditionalSettings
          options={options}
          set={change}
          disabled={disabled}
        />
        <button
          type="button"
          className="table-setting-reset"
          disabled={disabled}
          onClick={() => {
            const columns = { ...spec.columns };
            delete columns[id];
            set({ columns });
          }}
        >
          Сбросить настройки столбца
        </button>
      </div>
    </>
  );
}
function DataSettings({
  result,
  spec,
  set,
  disabled,
}: {
  result: ResultSet;
  spec: TableSpec;
  set: (patch: Partial<TableSpec>) => void;
  disabled: boolean;
}) {
  const columns = columnOptions(result.columns);
  const filters = spec.filters ?? [];
  const changeFilter = (index: number, patch: Partial<TableFilter>) =>
    set({
      filters: filters.map((filter, i) =>
        i === index ? { ...filter, ...patch } : filter,
      ),
    });
  const pivot = spec.pivot;
  const reshape = spec.reshape;
  const ids = tableReshapeIds(result.columns);
  const sortColumns = pivot
    ? columns.filter((c) => c.value === pivot.row)
    : reshape?.kind === "pivot"
      ? columns.filter((c) => reshape.rows.includes(c.value))
      : reshape?.kind === "melt"
        ? [
            ...columns.filter((c) => !reshape.columns.includes(c.value)),
            { value: ids.key, label: reshape.keyName ?? "Ключ" },
            { value: ids.value, label: reshape.valueName ?? "Значение" },
          ]
        : columns;
  return (
    <>
      <p className="table-setting-help">
        Фильтры, сортировка и итоги применяются ко всему снимку, а не к
        странице. Фильтры объединяются условием «И».
      </p>
      {filters.map((filter, index) => (
        <div className="table-setting-rule" key={index}>
          <div className="table-setting-rule-heading">
            <span>Фильтр {index + 1}</span>
            <button
              type="button"
              className="table-setting-remove"
              disabled={disabled}
              aria-label={`Удалить фильтр ${index + 1}`}
              title={`Удалить фильтр ${index + 1}`}
              onClick={() =>
                set({ filters: filters.filter((_, i) => i !== index) })
              }
            >
              <Trash size={16} aria-hidden="true" />
            </button>
          </div>
          <Choice
            label={`Фильтр ${index + 1} · столбец`}
            value={filter.column}
            options={columns}
            disabled={disabled}
            change={(column) => changeFilter(index, { column })}
          />
          <Choice
            label={`Условие фильтра ${index + 1}`}
            value={filter.op}
            options={operators}
            disabled={disabled}
            change={(op) =>
              changeFilter(index, { op: op as TableFilter["op"] })
            }
          />
          {!["isNull", "notNull"].includes(filter.op) && (
            <Draft
              label={`Значение фильтра ${index + 1}`}
              maxLength={2000}
              value={filter.value ?? ""}
              disabled={disabled}
              change={(value) => changeFilter(index, { value })}
            />
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={disabled || filters.length >= 20 || !columns.length}
        onClick={() =>
          set({
            filters: [
              ...filters,
              { column: columns[0].value, op: "contains", value: "" },
            ],
          })
        }
      >
        <Plus size={16} aria-hidden="true" /> Фильтр
      </button>
      <>
        <Choice
          label="Сортировать по"
          value={spec.sort?.column ?? ""}
          disabled={disabled}
          placeholder={pivot || reshape ? "По заголовку таблицы" : undefined}
          options={[
            { value: "", label: pivot || reshape ? "Нет" : "Как в SQL" },
            ...sortColumns,
          ]}
          change={(column) =>
            set({
              sort: column
                ? { column, direction: spec.sort?.direction ?? "asc" }
                : undefined,
            })
          }
        />
        {spec.sort && (
          <Choice
            label="Направление сортировки"
            value={spec.sort.direction}
            disabled={disabled}
            options={[
              { value: "asc", label: "По возрастанию" },
              { value: "desc", label: "По убыванию" },
            ]}
            change={(direction) =>
              set({
                sort: {
                  column: spec.sort!.column,
                  direction: direction as "asc" | "desc",
                },
              })
            }
          />
        )}
      </>
      <TableReshapeSettings
        columns={result.columns}
        spec={spec}
        set={set}
        disabled={disabled}
      />
    </>
  );
}
export default function TableSettings({
  result,
  spec,
  onChange,
  disabled = false,
}: {
  result: ResultSet;
  spec: TableSpec;
  onChange: (spec: TableSpec) => void;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState("columns");
  const mismatch = spec.sourceSchema !== tableSourceSchema(result.columns);
  const locked = disabled || mismatch;
  const set = (patch: Partial<TableSpec>) => {
    if (!locked) onChange({ ...spec, ...patch });
  };
  return (
    <div className="table-settings">
      <div className="table-settings-tabs" aria-label="Раздел настроек таблицы">
        {[
          ["columns", "Столбцы"],
          ["data", "Данные"],
          ["view", "Вид"],
        ].map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mismatch && (
        <div className="table-setting-warning" role="status">
          Схема снимка изменилась. Сбросьте настройки, чтобы настроить новые
          столбцы.
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(createTableSpec(result.columns))}
          >
            Сбросить для новой схемы
          </button>
        </div>
      )}
      {tab === "columns" && (
        <ColumnSettings
          result={result}
          spec={spec}
          set={set}
          disabled={locked}
        />
      )}
      {tab === "data" && (
        <DataSettings result={result} spec={spec} set={set} disabled={locked} />
      )}
      {tab === "view" && (
        <>
          <Choice
            label="Плотность строк"
            value={spec.density ?? "compact"}
            options={[
              { value: "compact", label: "Компактная" },
              { value: "comfortable", label: "Свободная" },
            ]}
            disabled={locked}
            change={(density) =>
              set({ density: density as TableSpec["density"] })
            }
          />
          <label className="table-setting-check">
            <input
              type="checkbox"
              checked={spec.wrap ?? false}
              disabled={locked}
              onChange={(e) => set({ wrap: e.target.checked })}
            />
            Переносить текст
          </label>
          <Choice
            label="Закрепить столбцы слева"
            value={String(spec.frozenColumns ?? 0)}
            disabled={locked}
            options={Array.from({ length: 4 }, (_, i) => ({
              value: String(i),
              label: i === 0 ? "Нет" : String(i),
            }))}
            change={(frozenColumns) =>
              set({ frozenColumns: Number(frozenColumns) })
            }
          />
          <p className="table-setting-help">
            Настройки сохраняются в блоке доски. Форматирование меняет только
            отображение значений.
          </p>
        </>
      )}
    </div>
  );
}
