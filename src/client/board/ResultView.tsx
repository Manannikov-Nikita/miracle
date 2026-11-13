import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import {
  createResultVisualTable,
  type VisualTableSpec,
} from "../../shared/visual-table";
import type { Cell, ChartSpec, ResultSet, TableSpec } from "../../shared/types";
import { getResultRows } from "../api";
import { Select } from "../components/Select";
import { ErrorBox } from "../components/UI";
import { isNumericColumn } from "./model";
import { chartOptions } from "./chartOptions";
import ChartCanvas from "./ChartCanvas";
import TableView from "./TableView";
import ChartTypePicker from "./ChartTypePicker";
import type { CustomChartSpec } from "../../shared/custom-charts";
import CustomChart from "./CustomChart";
import ChartColors from "./ChartColors";
import LegendPositionPicker from "./LegendPositionPicker";
import { normalizeChartSpec, tableChartSeries } from "./chartTableModel";
import { useChartTableData } from "./useChartTableData";
import { createTableSpec } from "./tableModel";
const SqlTableView = lazy(() => import("./SqlTableView"));

function Chart({
  result,
  spec: savedSpec,
  table,
  visibleColumns,
  presentationBackground,
}: {
  result: ResultSet;
  spec?: ChartSpec;
  table?: TableSpec;
  visibleColumns?: string[];
  presentationBackground?: string;
}) {
  const { data, error, preparationError, retry } = useChartTableData(
    result,
    table,
    visibleColumns,
  );
  const spec = useMemo(
    () => normalizeChartSpec(data?.columns ?? result.columns, savedSpec),
    [data?.columns, result.columns, savedSpec],
  );
  const prepared = useMemo(() => {
    if (preparationError) return { error: preparationError };
    if (!data || !data.rows.length) return null;
    try {
      const series = tableChartSeries(data, spec);
      const createOption = (selected: Record<string, boolean>) =>
        chartOptions(
          data.columns,
          spec,
          series,
          presentationBackground,
          selected,
        );
      return {
        option: chartOptions(
          data.columns,
          spec,
          series,
          presentationBackground,
        ),
        createOption:
          spec.kind === "bar" && spec.stacked && spec.series
            ? createOption
            : undefined,
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [data, spec, preparationError, presentationBackground]);
  if (error || prepared?.error)
    return (
      <ErrorBox
        className="board-error nowheel"
        error={error || prepared?.error}
        title={
          error
            ? "Не удалось загрузить данные графика."
            : "Не удалось построить график."
        }
        hint={
          error
            ? "Повторите загрузку сохранённого снимка."
            : (preparationError ??
              "Проверьте выбранные столбцы и тип графика в свойствах блока.")
        }
        actions={
          error ? (
            <button type="button" onClick={retry}>
              Повторить загрузку
            </button>
          ) : undefined
        }
      />
    );
  if (!data)
    return (
      <div className="board-loading" role="status">
        Загрузка полного снимка…
      </div>
    );
  if (!data.rows.length)
    return (
      <div className="board-loading">
        {table?.filters?.length
          ? "Нет строк, подходящих под фильтры."
          : "В результате нет строк."}
      </div>
    );
  if (!prepared?.option) return null;
  return (
    <ChartCanvas
      option={prepared.option}
      createOption={prepared.createOption}
      label={`График: ${spec.kind}${spec.kind === "bar" && spec.orientation === "horizontal" ? ", горизонтальный" : ""}, ${data.rows.length} строк таблицы`}
    />
  );
}
type ChartSettingsProps = {
  result: ResultSet;
  spec: ChartSpec;
  table?: TableSpec;
  visibleColumns?: string[];
  onChange: (value: ChartSpec) => void;
  onTableChange?: (value: TableSpec) => void;
  disabled?: boolean;
};
export function ChartSettings(props: ChartSettingsProps) {
  const { data, error, preparationError, retry } = useChartTableData(
    props.result,
    props.table,
    props.visibleColumns,
    false,
  );
  const transformed =
    props.table !== undefined || props.visibleColumns !== undefined;
  const spec = useMemo(
    () => normalizeChartSpec(data?.columns ?? props.result.columns, props.spec),
    [data?.columns, props.result.columns, props.spec],
  );
  const series = useMemo(() => {
    if (!data || !transformed) return undefined;
    try {
      return tableChartSeries(data, spec);
    } catch {
      return [];
    } // Invalid axes remain editable below.
  }, [data, transformed, spec]);
  if (error || preparationError)
    return (
      <ErrorBox
        title="Не удалось подготовить данные графика."
        error={error ?? preparationError}
        hint={preparationError ?? "Повторите загрузку сохранённого снимка."}
        actions={
          error ? (
            <button type="button" onClick={retry}>
              Повторить загрузку
            </button>
          ) : undefined
        }
      />
    );
  if (!data) return <p role="status">Загрузка столбцов таблицы…</p>;
  return (
    <ChartSettingsFields
      {...props}
      result={{
        ...props.result,
        columns: data.columns,
        rowCount: data.rows.length,
      }}
      spec={spec}
      preparedSeries={series}
      table={
        props.table ??
        createTableSpec(props.result.columns, props.visibleColumns)
      }
    />
  );
}
function ChartSettingsFields({
  result,
  spec,
  onChange,
  table,
  onTableChange,
  disabled = false,
  preparedSeries,
}: ChartSettingsProps & {
  preparedSeries?: ReturnType<typeof tableChartSeries>;
}) {
  const set = (patch: Partial<ChartSpec>) => onChange({ ...spec, ...patch });
  const horizontal = spec.kind === "bar" && spec.orientation === "horizontal";
  const categoryAxis = horizontal ? "Ось Y" : "Ось X";
  const metricAxis = horizontal ? "Ось X" : "Ось Y";
  const sortLabel = horizontal ? "Порядок Y" : "Порядок X";
  const categoryColumn = result.columns.find((column) => column.id === spec.x);
  const typeLabel = horizontal ? "Тип данных Y" : "Тип данных X";
  return (
    <fieldset className="board-chart-settings" disabled={disabled}>
      <legend>Настройки графика · весь снимок</legend>
      <ChartTypePicker
        value={spec.kind}
        orientation={spec.orientation}
        disabled={disabled}
        onChange={(kind) => set({ kind })}
      />
      {spec.kind === "bar" && (
        <label>
          <input
            type="checkbox"
            checked={horizontal}
            onChange={(event) =>
              set({
                orientation: event.target.checked ? "horizontal" : "vertical",
              })
            }
          />
          Горизонтально
        </label>
      )}
      <label>
        {categoryAxis}
        <Select
          aria-label={categoryAxis}
          disabled={disabled}
          value={spec.x}
          onValueChange={(value) => set({ x: value })}
          options={result.columns.map((c) => ({ value: c.id, label: c.name }))}
        />
      </label>
      {spec.kind !== "scatter" && categoryColumn && table && onTableChange && (
        <label>
          {typeLabel}
          <Select
            aria-label={typeLabel}
            disabled={disabled}
            value={table.columns?.[spec.x]?.dataType ?? "auto"}
            options={[
              { value: "auto", label: `Авто · ${categoryColumn.type}` },
              { value: "date", label: "Дата" },
            ]}
            onValueChange={(dataType) =>
              onTableChange({
                ...table,
                columns: {
                  ...table.columns,
                  [spec.x]: {
                    ...table.columns?.[spec.x],
                    dataType: dataType as "auto" | "date",
                  },
                },
              })
            }
          />
        </label>
      )}
      <div className="board-y-fields">
        {metricAxis}
        {result.columns.filter(isNumericColumn).map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={spec.y.includes(c.id)}
              onChange={(e) =>
                set({
                  y: e.target.checked
                    ? [...spec.y, c.id]
                    : spec.y.filter((id) => id !== c.id),
                })
              }
            />
            {c.name}
          </label>
        ))}
      </div>
      <label>
        Разбивка
        <Select
          aria-label="Разбивка"
          disabled={disabled}
          value={spec.series ?? ""}
          onValueChange={(value) => set({ series: value || undefined })}
          options={[
            { value: "", label: "Нет" },
            ...result.columns.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      </label>
      {spec.kind !== "scatter" && spec.series && (
        <label>
          <input
            type="checkbox"
            checked={spec.stacked ?? false}
            onChange={(e) => set({ stacked: e.target.checked })}
          />
          С накоплением
        </label>
      )}
      <label>
        {sortLabel}
        <Select
          aria-label={sortLabel}
          disabled={disabled}
          value={spec.sort ?? "none"}
          onValueChange={(value) => set({ sort: value as ChartSpec["sort"] })}
          options={[
            { value: "none", label: "Как в таблице" },
            { value: "asc", label: "По возрастанию" },
            { value: "desc", label: "По убыванию" },
          ]}
        />
      </label>
      <details className="board-chart-appearance">
        <summary>Оформление</summary>
        <div className="board-chart-appearance-fields">
          <div className="board-chart-visibility">
            <label>
              <input
                type="checkbox"
                aria-label="Показывать ось X"
                checked={spec.showXAxis ?? true}
                onChange={(event) => set({ showXAxis: event.target.checked })}
              />
              Ось X
            </label>
            <label>
              <input
                type="checkbox"
                aria-label="Показывать ось Y"
                checked={spec.showYAxis ?? true}
                onChange={(event) => set({ showYAxis: event.target.checked })}
              />
              Ось Y
            </label>
            <label>
              <input
                type="checkbox"
                checked={spec.showGrid ?? true}
                onChange={(event) => set({ showGrid: event.target.checked })}
              />
              Сетка
            </label>
            <label>
              <input
                type="checkbox"
                checked={spec.showLabels ?? false}
                onChange={(event) => set({ showLabels: event.target.checked })}
              />
              Подписи значений
            </label>
            {spec.kind === "bar" && spec.stacked && spec.series && (
              <label>
                <input
                  type="checkbox"
                  checked={spec.showTotals !== false}
                  onChange={(event) =>
                    set({ showTotals: event.target.checked })
                  }
                />
                Итоги столбцов
              </label>
            )}
          </div>
          {spec.showLabels && spec.kind === "bar" && (
            <label>
              Положение подписей
              <Select
                aria-label="Положение подписей"
                disabled={disabled}
                value={spec.labelPosition ?? "auto"}
                onValueChange={(value) =>
                  set({ labelPosition: value as ChartSpec["labelPosition"] })
                }
                options={[
                  { value: "auto", label: "Авто" },
                  { value: "outside", label: "Снаружи" },
                  { value: "inside", label: "Внутри" },
                ]}
              />
            </label>
          )}
          <label>
            Числа
            <Select
              aria-label="Числа"
              disabled={disabled}
              value={spec.numberFormat ?? "auto"}
              onValueChange={(value) =>
                set({ numberFormat: value as ChartSpec["numberFormat"] })
              }
              options={[
                { value: "auto", label: "Авто" },
                { value: "compact", label: "Компактно · 34.1k" },
                { value: "integer", label: "Целые" },
                { value: "decimal", label: "2 знака" },
                { value: "percent", label: "Проценты" },
              ]}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={spec.legend}
              onChange={(e) => set({ legend: e.target.checked })}
            />
            Легенда
          </label>
          {spec.legend && (
            <LegendPositionPicker
              position={spec.legendPosition}
              align={spec.legendAlign}
              disabled={disabled}
              onChange={set}
            />
          )}
          <ChartColors
            key={result.id}
            result={result}
            spec={spec}
            disabled={disabled}
            onChange={set}
            preparedSeries={preparedSeries}
          />
        </div>
      </details>
      <p>До 5 000 точек. Данные учитывают преобразования таблицы.</p>
    </fieldset>
  );
}
export default function ResultView({
  boardId,
  nodeId,
  id,
  view,
  chart,
  customChart,
  visibleColumns,
  table,
  onMetadata,
  reportChartStatus,
  presentationBackground,
  onTableChange,
  visualTable,
  visualTableEnabled,
  onVisualTableChange,
  onVisualTableToggle,
}: {
  boardId?: string;
  nodeId?: string;
  id: string;
  view: "table" | "chart" | "custom";
  chart?: ChartSpec;
  customChart?: CustomChartSpec;
  visibleColumns?: string[];
  table?: TableSpec;
  reportChartStatus?: boolean;
  presentationBackground?: string;
  onMetadata?: (result: ResultSet) => void;
  onTableChange?: (table: TableSpec) => void;
  visualTable?: VisualTableSpec;
  visualTableEnabled?: boolean;
  onVisualTableChange?: (table: VisualTableSpec) => void;
  onVisualTableToggle?: (enabled: boolean, table?: VisualTableSpec) => void;
}) {
  const [result, setResult] = useState<ResultSet | null>(null);
  const [rows, setRows] = useState<Cell[][]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);
  const [showCustomTable, setShowCustomTable] = useState(false);
  const [visualError, setVisualError] = useState("");
  useEffect(() => setShowCustomTable(false), [id, view, boardId, nodeId]);
  useEffect(() => {
    setRows([]);
    setResult(null);
  }, [id]);
  useEffect(() => {
    let live = true;
    setError(null);
    getResultRows(id, 0, 200)
      .then((page) => {
        if (!live) return;
        setRows(page.rows);
        setResult(page.result);
        onMetadata?.(page.result);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      live = false;
    };
  }, [id, retry]);
  if (view === "custom" && !showCustomTable) {
    if (!customChart || !boardId || !nodeId)
      return (
        <ErrorBox
          className="board-error nowheel"
          title="Не удалось открыть кастомный график."
          error="Не найдены исходники или адрес блока."
          hint="Попросите агента восстановить график. Данные доступны в таблице."
          actions={
            <button type="button" onClick={() => setShowCustomTable(true)}>
              Показать таблицу
            </button>
          }
        />
      );
    return (
      <CustomChart
        boardId={boardId}
        nodeId={nodeId}
        resultSetId={id}
        spec={customChart}
        table={table}
        visibleColumns={visibleColumns}
        reportStatus={reportChartStatus}
        onShowTable={() => setShowCustomTable(true)}
      />
    );
  }
  const content = error ? (
    <ErrorBox
      className="board-error nowheel"
      error={error}
      title="Не удалось загрузить снимок."
      hint="Повторите загрузку данных этого блока."
      actions={
        <button type="button" onClick={() => setRetry((n) => n + 1)}>
          Повторить загрузку
        </button>
      }
    />
  ) : !result || result.id !== id ? (
    <div className="board-loading" role="status">
      Загрузка снимка…
    </div>
  ) : view === "chart" ? (
    <Chart
      result={result}
      spec={chart}
      table={table}
      visibleColumns={visibleColumns}
      presentationBackground={presentationBackground}
    />
  ) : view === "table" && visualTableEnabled && visualTable ? (
    <Suspense fallback={<div className="board-loading">Загрузка таблицы…</div>}>
      <SqlTableView
        key={`${boardId}:${nodeId}`}
        spec={visualTable}
        result={result}
        editable={!!onVisualTableChange}
        onChange={onVisualTableChange}
        presentationBackground={presentationBackground}
        onExit={
          onVisualTableToggle ? () => onVisualTableToggle(false) : undefined
        }
      />
    </Suspense>
  ) : (
    <div className="board-table-with-formulas">
      {view === "table" && onVisualTableToggle && (
        <div className="board-table-formulas-toggle">
          {visualError && <span role="alert">{visualError}</span>}
          <button
            type="button"
            onClick={() => {
              try {
                onVisualTableToggle(
                  true,
                  visualTable ?? createResultVisualTable(result),
                );
                setVisualError("");
              } catch (error) {
                setVisualError((error as Error).message);
              }
            }}
            title="Редактировать значения и формулы над исходным снимком SQL"
          >
            ƒ Формулы
          </button>
        </div>
      )}
      <TableView
        key={id}
        result={result}
        initialRows={rows}
        spec={table}
        visibleColumns={visibleColumns}
        onChange={onTableChange}
      />
    </div>
  );
  return view === "custom" ? (
    <div className="board-custom-table-preview">
      <button type="button" onClick={() => setShowCustomTable(false)}>
        Вернуться к графику
      </button>
      {content}
    </div>
  ) : (
    content
  );
}
