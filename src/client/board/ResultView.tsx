import { useEffect, useMemo, useState } from "react";
import type { Cell, ChartSpec, ResultSet, TableSpec } from "../../shared/types";
import { api, getResultRows } from "../api";
import { Select } from "../components/Select";
import { chartSeries, defaultChart, isNumericColumn } from "./model";
import { chartOptions } from "./chartOptions";
import ChartCanvas from "./ChartCanvas";
import TableView from "./TableView";
import ChartTypePicker from "./ChartTypePicker";

function Chart({ result, spec }: { result: ResultSet; spec: ChartSpec }) {
  const [rows, setRows] = useState<Cell[][] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setRows(null);
    setError("");
    api<{ result: ResultSet; rows: Cell[][] }>(
      `/api/result-sets/${result.id}/chart`,
    )
      .then((data) => {
        if (live) setRows(data.rows);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [result.id, retry]);
  const prepared = useMemo(() => {
    if (!rows) return null;
    try {
      const series = chartSeries(result.columns, rows, spec);
      return { option: chartOptions(result.columns, spec, series) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [result, rows, spec]);
  if (error || prepared?.error)
    return (
      <div className="board-error" role="alert">
        {error || prepared?.error}
        {error && (
          <button onClick={() => setRetry((n) => n + 1)}>Повторить</button>
        )}
      </div>
    );
  if (!rows)
    return (
      <div className="board-loading" role="status">
        Загрузка полного снимка…
      </div>
    );
  if (!rows.length)
    return <div className="board-loading">В результате нет строк.</div>;
  if (!prepared?.option) return null;
  return (
    <ChartCanvas
      option={prepared.option}
      label={`График: ${spec.kind}${spec.kind === "bar" && spec.orientation === "horizontal" ? ", горизонтальный" : ""}, ${rows.length} строк полного снимка`}
    />
  );
}
export function ChartSettings({
  result,
  spec,
  onChange,
  disabled = false,
}: {
  result: ResultSet;
  spec: ChartSpec;
  onChange: (value: ChartSpec) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ChartSpec>) => onChange({ ...spec, ...patch });
  const horizontal = spec.kind === "bar" && spec.orientation === "horizontal";
  const categoryAxis = horizontal ? "Ось Y" : "Ось X";
  const metricAxis = horizontal ? "Ось X" : "Ось Y";
  const sortLabel = horizontal ? "Порядок Y" : "Порядок X";
  const verticalLegend =
    spec.legendPosition === "left" || spec.legendPosition === "right";
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
        {sortLabel}
        <Select
          aria-label={sortLabel}
          disabled={disabled}
          value={spec.sort ?? "none"}
          onValueChange={(value) => set({ sort: value as ChartSpec["sort"] })}
          options={[
            { value: "none", label: "Как в SQL" },
            { value: "asc", label: "По возрастанию" },
            { value: "desc", label: "По убыванию" },
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
        <>
          <label>
            Положение легенды
            <Select
              aria-label="Положение легенды"
              disabled={disabled}
              value={spec.legendPosition ?? "top"}
              onValueChange={(value) =>
                set({ legendPosition: value as ChartSpec["legendPosition"] })
              }
              options={[
                { value: "top", label: "Сверху" },
                { value: "bottom", label: "Снизу" },
                { value: "left", label: "Слева" },
                { value: "right", label: "Справа" },
              ]}
            />
          </label>
          <label>
            Выравнивание легенды
            <Select
              aria-label="Выравнивание легенды"
              disabled={disabled}
              value={spec.legendAlign ?? "center"}
              onValueChange={(value) =>
                set({ legendAlign: value as ChartSpec["legendAlign"] })
              }
              options={[
                {
                  value: "start",
                  label: verticalLegend ? "По верхнему краю" : "По левому краю",
                },
                { value: "center", label: "По центру" },
                {
                  value: "end",
                  label: verticalLegend ? "По нижнему краю" : "По правому краю",
                },
              ]}
            />
          </label>
        </>
      )}
      <p>До 5 000 точек. Агрегация и округление задаются в SQL.</p>
    </fieldset>
  );
}
export default function ResultView({
  id,
  view,
  chart,
  visibleColumns,
  table,
  onTableChange,
  onMetadata,
}: {
  id: string;
  view: "table" | "chart";
  chart?: ChartSpec;
  visibleColumns?: string[];
  table?: TableSpec;
  onTableChange?: (spec: TableSpec) => void;
  onMetadata?: (result: ResultSet) => void;
}) {
  const [result, setResult] = useState<ResultSet | null>(null);
  const [rows, setRows] = useState<Cell[][]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setRows([]);
    setResult(null);
  }, [id]);
  useEffect(() => {
    let live = true;
    setError("");
    getResultRows(id, 0, 200)
      .then((page) => {
        if (!live) return;
        setRows(page.rows);
        setResult(page.result);
        onMetadata?.(page.result);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [id, retry]);
  if (error)
    return (
      <div className="board-error" role="alert">
        {error}
        <button onClick={() => setRetry((n) => n + 1)}>Повторить</button>
      </div>
    );
  if (!result || result.id !== id)
    return (
      <div className="board-loading" role="status">
        Загрузка снимка…
      </div>
    );
  if (view === "chart")
    return (
      <Chart result={result} spec={chart ?? defaultChart(result.columns)} />
    );
  return (
    <TableView
      key={id}
      result={result}
      initialRows={rows}
      spec={table}
      visibleColumns={visibleColumns}
      onChange={onTableChange}
    />
  );
}
