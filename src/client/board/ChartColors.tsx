import { useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { Cell, ChartSpec, ResultSet } from "../../shared/types";
import {
  CHART_PALETTES,
  CHART_SERIES_COLOR_LIMIT,
  CHART_SERIES_COLOR_KEY_LIMIT,
  chartSeriesColor,
  chartSeriesColorKey,
} from "../../shared/chart-appearance";
import { api } from "../api";
import { Select } from "../components/Select";
import { chartSeries } from "./model";

function SeriesColor({
  name,
  color,
  custom,
  disabled,
  onChange,
  onReset,
}: {
  name: string;
  color: string;
  custom: boolean;
  disabled: boolean;
  onChange: (color: string) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(color);
  useEffect(() => setDraft(color), [color]);
  const valid = /^#[0-9a-f]{6}$/i.test(draft);
  return (
    <div className="board-chart-color-row">
      <span className="board-chart-color-name" title={name}>
        {name}
      </span>
      <input
        type="color"
        aria-label={`Цвет · ${name}`}
        value={color}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        className="board-chart-color-hex"
        aria-label={`HEX · ${name}`}
        aria-invalid={!valid || undefined}
        value={draft}
        maxLength={7}
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => setDraft(color)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(color);
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className="board-chart-color-reset"
        aria-label={`Сбросить цвет · ${name}`}
        title="Вернуть цвет палитры"
        disabled={disabled || !custom}
        onClick={onReset}
      >
        <ArrowCounterClockwise size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function ChartColors({
  result,
  spec,
  disabled,
  onChange,
  preparedSeries,
}: {
  result: ResultSet;
  spec: ChartSpec;
  disabled: boolean;
  onChange: (patch: Partial<ChartSpec>) => void;
  preparedSeries?: ReturnType<typeof chartSeries>;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ id: string; rows: Cell[][] }>();
  const [error, setError] = useState<{ id: string; message: string }>();
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(30);
  const needsRows =
    preparedSeries === undefined && open && Boolean(spec.series);
  useEffect(() => {
    if (!needsRows || snapshot?.id === result.id) return;
    const controller = new AbortController();
    setError(undefined);
    api<{ rows: Cell[][] }>(
      `/api/result-sets/${encodeURIComponent(result.id)}/chart`,
      { signal: controller.signal },
    )
      .then(({ rows }) => {
        if (!controller.signal.aborted) setSnapshot({ id: result.id, rows });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError({
            id: result.id,
            message: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => controller.abort();
  }, [needsRows, result.id, snapshot?.id, retry]);
  const prepared = useMemo(() => {
    if (preparedSeries !== undefined) return { series: preparedSeries };
    if (!spec.series)
      return {
        series: spec.y.flatMap((id) => {
          const column = result.columns.find((column) => column.id === id);
          return column
            ? [
                {
                  name: column.name,
                  colorKey: chartSeriesColorKey(id, undefined, undefined),
                },
              ]
            : [];
        }),
      };
    if (snapshot?.id !== result.id) return { series: [] };
    try {
      return { series: chartSeries(result.columns, snapshot.rows, spec) };
    } catch (cause) {
      return { series: [], error: (cause as Error).message };
    }
  }, [result.id, result.columns, snapshot, spec, preparedSeries]);
  const series = prepared.series
    .filter(
      (item): item is typeof item & { colorKey: string } =>
        typeof item.colorKey === "string",
    )
    .map((item, index) => ({
      ...item,
      color: chartSeriesColor(spec, item, index),
    }));
  const filtered = series.filter((item) =>
    item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  const colors = spec.seriesColors ?? {};
  const atColorLimit = Object.keys(colors).length >= CHART_SERIES_COLOR_LIMIT;
  const message =
    (preparedSeries === undefined && spec.series && error?.id === result.id
      ? error.message
      : undefined) ?? prepared.error;
  const loading =
    preparedSeries === undefined &&
    Boolean(spec.series) &&
    snapshot?.id !== result.id &&
    !message;
  const palette =
    CHART_PALETTES.find((item) => item.id === (spec.palette ?? "default")) ??
    CHART_PALETTES[0];
  return (
    <div className="board-chart-colors">
      <label>
        Палитра
        <Select
          aria-label="Палитра"
          disabled={disabled}
          value={spec.palette ?? "default"}
          onValueChange={(value) =>
            onChange({ palette: value as ChartSpec["palette"] })
          }
          options={CHART_PALETTES.map((item) => ({
            value: item.id,
            label: item.name,
          }))}
        />
      </label>
      <div className="board-chart-palette-preview" aria-hidden="true">
        {palette.colors.map((color) => (
          <span key={color} style={{ background: color }} />
        ))}
      </div>
      <details
        className="board-chart-series-colors"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>Цвета серий</summary>
        {open && (
          <div className="board-chart-series-fields">
            {message ? (
              <div className="board-chart-colors-error" role="status">
                <p title={message}>Не удалось загрузить цвета серий.</p>
                {!prepared.error && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    Повторить
                  </button>
                )}
                {prepared.error && <p>{prepared.error}</p>}
              </div>
            ) : loading ? (
              <p role="status">Загрузка серий…</p>
            ) : (
              <>
                {(series.length > 30 || filter) && (
                  <input
                    aria-label="Найти серию"
                    placeholder="Найти серию…"
                    value={filter}
                    disabled={disabled}
                    onChange={(event) => {
                      setFilter(event.target.value);
                      setLimit(30);
                    }}
                  />
                )}
                <div className="board-chart-series-list">
                  {filtered.slice(0, limit).map((item) => (
                    <SeriesColor
                      key={item.colorKey}
                      name={item.name}
                      color={item.color}
                      custom={Object.hasOwn(colors, item.colorKey)}
                      disabled={
                        disabled ||
                        item.colorKey.length > CHART_SERIES_COLOR_KEY_LIMIT ||
                        (atColorLimit && !Object.hasOwn(colors, item.colorKey))
                      }
                      onChange={(color) =>
                        onChange({
                          seriesColors: { ...colors, [item.colorKey]: color },
                        })
                      }
                      onReset={() => {
                        const next = { ...colors };
                        delete next[item.colorKey];
                        onChange({
                          seriesColors: Object.keys(next).length
                            ? next
                            : undefined,
                        });
                      }}
                    />
                  ))}
                </div>
                {series.some(
                  (item) => item.colorKey.length > CHART_SERIES_COLOR_KEY_LIMIT,
                ) && (
                  <p>
                    Сократите длинные названия групп в SQL, чтобы задать им
                    отдельный цвет.
                  </p>
                )}
                {!filtered.length && (
                  <p>
                    {series.length
                      ? "Серии не найдены."
                      : spec.y.length
                        ? "В снимке нет серий."
                        : "Выберите числовой столбец."}
                  </p>
                )}
                {filtered.length > limit && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setLimit((value) => value + 30)}
                  >
                    Показать ещё
                  </button>
                )}
              </>
            )}
            {atColorLimit && (
              <p>Чтобы задать новые цвета, сначала верните цвета палитры.</p>
            )}
            {Object.keys(colors).length > 0 && (
              <button
                type="button"
                className="board-chart-colors-clear"
                disabled={disabled}
                onClick={() => onChange({ seriesColors: undefined })}
              >
                Вернуть цвета палитры
              </button>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
