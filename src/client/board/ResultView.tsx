import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type ComponentProps,
} from "react";
import {
  createResultVisualTable,
  type VisualTableSpec,
} from "../../shared/visual-table";
import type {
  Cell,
  ChartMetricStyle,
  ChartSpec,
  ResultSet,
  TableSpec,
} from "../../shared/types";
import {
  CHART_METRIC_LIMIT,
  composedMetricStyle,
  supportsChartStacking,
} from "../../shared/chart-appearance";
import { getResultRows } from "../api";
import { Select } from "../components/Select";
import { ErrorBox } from "../components/UI";
import { isNumericColumn } from "./model";
import BoardChartPlot from "./BoardChartPlot";
import ChartLoadFrame from "./ChartLoadFrame";
import TableView from "./TableView";
import ChartTypePicker from "./ChartTypePicker";
import HistogramBinCount from "./HistogramBinCount";
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
  refreshing,
  waitingForMetadata,
}: {
  result: ResultSet | null;
  spec?: ChartSpec;
  table?: TableSpec;
  visibleColumns?: string[];
  presentationBackground?: string;
  refreshing: boolean;
  waitingForMetadata: boolean;
}) {
  const { data, error, preparationError, retry } = useChartTableData(
    result,
    table,
    visibleColumns,
    savedSpec?.kind === "histogram" ? "histogram" : "chart",
  );
  const prepared = useMemo(() => {
    if (waitingForMetadata || !data?.rows.length) return null;
    try {
      const spec = normalizeChartSpec(data.columns, savedSpec);
      return {
        plot: {
          spec,
          columns: data.columns,
          series: tableChartSeries(data, spec),
          presentationBackground,
          label: `График: ${spec.kind}${spec.kind === "bar" && spec.orientation === "horizontal" ? ", горизонтальный" : ""}, ${data.rows.length} строк таблицы`,
        },
      };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [data, savedSpec, presentationBackground, waitingForMetadata]);

  const waitingForRows = waitingForMetadata || !data;
  const failure =
    !waitingForMetadata && (error || preparationError || prepared?.error);
  const lastPlot = useRef<
    | {
        plot: ComponentProps<typeof BoardChartPlot>;
        savedSpec?: ChartSpec;
      }
    | undefined
  >(undefined);
  // Retain exactly the visible plot while both the metadata and full rows are replaced.
  useLayoutEffect(() => {
    if (!waitingForRows || failure)
      lastPlot.current = prepared?.plot
        ? { plot: prepared.plot, savedSpec }
        : undefined;
  }, [waitingForRows, prepared, failure, savedSpec]);

  if (failure && !refreshing)
    return (
      <ErrorBox
        className="board-error nowheel"
        error={failure}
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
  // A snapshot may change alongside its saved chart settings. Only reuse a
  // layout when it still describes the requested axes, series and appearance.
  const retained = lastPlot.current;
  const sameSettings =
    waitingForRows &&
    retained &&
    (retained.savedSpec === savedSpec ||
      JSON.stringify(retained.savedSpec) === JSON.stringify(savedSpec));
  const plot = waitingForRows
    ? sameSettings
      ? retained.plot
      : undefined
    : prepared?.plot;
  const busy = refreshing || waitingForRows;
  return (
    <ChartLoadFrame
      busy={busy}
      inlineSkeleton={!!plot}
      refreshing={refreshing}
      spec={savedSpec}
      count={
        result &&
        !waitingForMetadata &&
        (!savedSpec?.series || savedSpec.kind === "histogram") &&
        !table?.reshape &&
        !table?.filters?.length
          ? savedSpec?.kind === "histogram"
            ? result.rowCount
            : Math.min(result.rowCount, 32)
          : undefined
      }
    >
      {plot ? (
        <BoardChartPlot {...plot} loading={busy} />
      ) : !busy ? (
        <div className="board-loading">
          {table?.filters?.length
            ? "Нет строк, подходящих под фильтры."
            : "В результате нет строк."}
        </div>
      ) : null}
    </ChartLoadFrame>
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
    props.spec.kind === "histogram" ? "histogram" : "metadata",
  );
  const transformed =
    props.table !== undefined || props.visibleColumns !== undefined;
  const spec = useMemo(
    () => normalizeChartSpec(data?.columns ?? props.result.columns, props.spec),
    [data?.columns, props.result.columns, props.spec],
  );
  const series = useMemo(() => {
    if (!data) return spec.kind === "histogram" ? [] : undefined;
    if (!transformed && spec.kind !== "histogram") return undefined;
    try {
      return tableChartSeries(data, spec);
    } catch {
      return [];
    } // Invalid axes remain editable below.
  }, [data, transformed, spec]);
  if (error || preparationError)
    return (
      <>
        {props.spec.kind === "histogram" && (
          <ChartTypePicker
            spec={props.spec}
            columns={props.result.columns}
            disabled={Boolean(props.disabled)}
            onChange={props.onChange}
          />
        )}
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
      </>
    );
  // Raw column metadata is sufficient to edit histogram bindings while its
  // immutable full snapshot is still being read for grouped colors.
  if (!data && (transformed || spec.kind !== "histogram"))
    return <p role="status">Загрузка столбцов таблицы…</p>;
  return (
    <ChartSettingsFields
      {...props}
      result={{
        ...props.result,
        columns: data?.columns ?? props.result.columns,
        rowCount: data?.rows.length ?? props.result.rowCount,
      }}
      spec={spec}
      preparingSeries={!data}
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
  preparingSeries,
}: ChartSettingsProps & {
  preparingSeries: boolean;
  preparedSeries?: ReturnType<typeof tableChartSeries>;
}) {
  const set = (patch: Partial<ChartSpec>) => onChange({ ...spec, ...patch });
  const horizontal = spec.kind === "bar" && spec.orientation === "horizontal";
  const sparkline = spec.kind === "sparkline";
  const heatmap = spec.kind === "heatmap";
  const histogram = spec.kind === "histogram";
  const categoryAxis = histogram
    ? "Числовой столбец"
    : sparkline
      ? "Категория"
      : horizontal
        ? "Ось Y"
        : "Ось X";
  const numericColumns = result.columns.filter(isNumericColumn);
  const numberFormatLabel = histogram ? "Числа на оси X" : "Числа";
  const metricAxis = heatmap
    ? "Значения ячеек"
    : sparkline
      ? "Метрики"
      : horizontal
        ? "Ось X"
        : "Ось Y";
  const sortLabel = horizontal ? "Порядок Y" : "Порядок X";
  const categoryColumn = result.columns.find((column) => column.id === spec.x);
  const typeLabel = horizontal ? "Тип данных Y" : "Тип данных X";
  return (
    <fieldset className="board-chart-settings" disabled={disabled}>
      <legend>Настройки графика · весь снимок</legend>
      <ChartTypePicker
        spec={spec}
        columns={result.columns}
        disabled={disabled}
        onChange={onChange}
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
          disabled={disabled || (histogram && !numericColumns.length)}
          placeholder={
            histogram && !numericColumns.length
              ? "Нет числовых столбцов"
              : undefined
          }
          value={spec.x}
          onValueChange={(value) => set({ x: value })}
          options={(histogram ? numericColumns : result.columns).map((c) => ({
            value: c.id,
            label: c.name,
          }))}
        />
      </label>
      {histogram && (
        <>
          <HistogramBinCount
            value={spec.binCount}
            onChange={(binCount) => set({ binCount })}
            disabled={disabled}
          />
        </>
      )}
      {!histogram &&
        spec.kind !== "scatter" &&
        categoryColumn &&
        table &&
        onTableChange && (
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
      {!histogram && (
        <div className="board-y-fields">
          {metricAxis}
          {numericColumns.map((c) => (
            <div className="board-chart-metric" key={c.id}>
              <label>
                <input
                  type="checkbox"
                  checked={spec.y.includes(c.id)}
                  disabled={
                    !spec.y.includes(c.id) &&
                    spec.y.length >= CHART_METRIC_LIMIT
                  }
                  onChange={(event) =>
                    set({
                      y: event.target.checked
                        ? [...spec.y, c.id]
                        : spec.y.filter((id) => id !== c.id),
                    })
                  }
                />
                {c.name}
              </label>
              {spec.kind === "composed" && spec.y.includes(c.id) && (
                <Select
                  aria-label={`Вид метрики · ${c.name}`}
                  value={composedMetricStyle(spec, c.id)}
                  disabled={disabled}
                  options={[
                    { value: "bar", label: "Столбцы" },
                    { value: "line", label: "Линия" },
                    { value: "area", label: "Область" },
                  ]}
                  onValueChange={(value) => {
                    const selectedStyles = Object.entries(
                      spec.metricStyles ?? {},
                    ).filter(([id]) => spec.y.includes(id));
                    set({
                      metricStyles: {
                        ...Object.fromEntries(selectedStyles),
                        [c.id]: value as ChartMetricStyle,
                      },
                    });
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
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
      {(histogram || supportsChartStacking(spec.kind)) && spec.series && (
        <label>
          <input
            type="checkbox"
            checked={spec.stacked ?? false}
            onChange={(e) => set({ stacked: e.target.checked })}
          />
          С накоплением
        </label>
      )}
      {!histogram && (
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
      )}
      <div className="board-chart-legend">
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
      </div>
      <details className="board-chart-appearance">
        <summary>Оформление</summary>
        <div className="board-chart-appearance-fields">
          <div className="board-chart-visibility">
            {!sparkline && (
              <>
                <label>
                  <input
                    type="checkbox"
                    aria-label="Показывать ось X"
                    checked={spec.showXAxis ?? true}
                    onChange={(event) =>
                      set({ showXAxis: event.target.checked })
                    }
                  />
                  Ось X
                </label>
                <label>
                  <input
                    type="checkbox"
                    aria-label="Показывать ось Y"
                    checked={spec.showYAxis ?? true}
                    onChange={(event) =>
                      set({ showYAxis: event.target.checked })
                    }
                  />
                  Ось Y
                </label>
                {!heatmap && (
                  <label>
                    <input
                      type="checkbox"
                      checked={spec.showGrid ?? true}
                      onChange={(event) =>
                        set({ showGrid: event.target.checked })
                      }
                    />
                    Сетка
                  </label>
                )}
              </>
            )}
            <label>
              <input
                type="checkbox"
                checked={spec.showLabels ?? false}
                onChange={(event) => set({ showLabels: event.target.checked })}
              />
              {sparkline ? "Последнее значение" : "Подписи значений"}
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
            {numberFormatLabel}
            <Select
              aria-label={numberFormatLabel}
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
          <ChartColors
            key={result.id}
            result={result}
            spec={spec}
            disabled={disabled}
            onChange={set}
            preparedSeries={preparedSeries}
            preparing={preparingSeries}
          />
        </div>
      </details>
      <p>
        {histogram
          ? "До 50 000 исходных строк. Высота столбца показывает число значений в интервале."
          : "До 5 000 точек. Данные учитывают преобразования таблицы."}
      </p>
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
  refreshing = false,
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
  refreshing?: boolean;
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
  const [failure, setFailure] = useState<{ id: string; error: Error }>();
  const error = failure?.id === id ? failure.error : undefined;
  const [retry, setRetry] = useState(0);
  const [showCustomTable, setShowCustomTable] = useState(false);
  const [visualError, setVisualError] = useState("");
  useEffect(() => setShowCustomTable(false), [id, view, boardId, nodeId]);
  useEffect(() => {
    let live = true;
    setFailure(undefined);
    getResultRows(id, 0, 200)
      .then((page) => {
        if (!live) return;
        setRows(page.rows);
        setResult(page.result);
        onMetadata?.(page.result);
      })
      .catch((e) => {
        if (live)
          setFailure({
            id,
            error: e instanceof Error ? e : new Error(String(e)),
          });
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
  if (error && view === "chart" && refreshing)
    return <ChartLoadFrame busy refreshing spec={chart} />;
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
  ) : view === "chart" ? (
    <Chart
      refreshing={refreshing}
      waitingForMetadata={result?.id !== id}
      result={result}
      spec={chart}
      table={table}
      visibleColumns={visibleColumns}
      presentationBackground={presentationBackground}
    />
  ) : !result || result.id !== id ? (
    <div className="board-loading" role="status">
      Загрузка снимка…
    </div>
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
