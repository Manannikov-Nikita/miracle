import { useEffect, useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
} from "@phosphor-icons/react";
import type {
  Cell,
  ChartMarkStyle,
  ChartSpec,
  ResultSet,
} from "../../shared/types";
import {
  CHART_PALETTES,
  CHART_SERIES_COLOR_LIMIT,
  CHART_SERIES_COLOR_KEY_LIMIT,
  chartPalette,
  chartSeriesColor,
  chartSeriesColorKey,
} from "../../shared/chart-appearance";
import { api } from "../api";
import { Select } from "../components/Select";
import { chartSeries } from "./model";
import ColorPicker from "../colors/ColorPicker";

import ChartMarkRules from "./ChartMarkRules";
import ChartMarkStyleFields, { setMarkProperty } from "./ChartMarkStyleFields";

function withoutKey<T>(values: Record<string, T>, key: string) {
  const next = { ...values };
  delete next[key];
  return Object.keys(next).length ? next : undefined;
}

function SeriesColor({
  name,
  color,
  custom,
  disabled,
  onChange,
  onReset,
  style,
  disabledStyle,
  changeStyle,
  clearStyle,
}: {
  name: string;
  color: string;
  custom: boolean;
  disabled: boolean;
  onChange: (color: string) => void;
  onReset: () => void;
  style: ChartMarkStyle;
  disabledStyle: boolean;
  changeStyle: (next: ChartMarkStyle) => void;
  clearStyle: () => void;
}) {
  const [draft, setDraft] = useState(color);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setDraft(color), [color]);
  const valid = /^#[0-9a-f]{6}$/i.test(draft);
  return (
    <div className="chart-mark-series">
      <div className="board-chart-color-row">
        <button
          type="button"
          className="chart-mark-disclosure"
          title={name}
          aria-label={`Стиль · ${name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <CaretDown aria-hidden="true" />
          ) : (
            <CaretRight aria-hidden="true" />
          )}
          <span>{name}</span>
        </button>
        <ColorPicker
          label={`Цвет · ${name}`}
          value={color}
          disabled={disabled}
          compact
          onChange={onChange}
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
      {expanded && (
        <div className="chart-mark-series-editor">
          <ChartMarkStyleFields
            style={style}
            context={name}
            disabled={disabledStyle}
            onChange={changeStyle}
            baseColor={color}
          />
          {(custom || Object.keys(style).length > 0) && (
            <button
              type="button"
              disabled={disabledStyle && disabled}
              aria-label={`Сбросить стиль · ${name}`}
              onClick={clearStyle}
            >
              Сбросить стиль серии
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChartColors({
  result,
  spec,
  disabled,
  onChange,
  preparedSeries,
  preparing = false,
}: {
  preparing?: boolean;
  result: ResultSet;
  spec: ChartSpec;
  disabled: boolean;
  onChange: (patch: Partial<ChartSpec>) => void;
  preparedSeries?: ReturnType<typeof chartSeries>;
}) {
  const [open, setOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ id: string; rows: Cell[][] }>();
  const [error, setError] = useState<{ id: string; message: string }>();
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(30);
  const needsRows =
    preparedSeries === undefined && (open || rulesOpen) && Boolean(spec.series);
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
        series: (spec.kind === "histogram" ? [spec.x] : spec.y).flatMap(
          (id) => {
            const column = result.columns.find((column) => column.id === id);
            return column
              ? [
                  {
                    name: column.name,
                    colorKey: chartSeriesColorKey(id, undefined, undefined),
                  },
                ]
              : [];
          },
        ),
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
  const styles = spec.seriesStyles ?? {};
  const atStyleLimit = Object.keys(styles).length >= CHART_SERIES_COLOR_LIMIT;
  const hasCustomColors =
    Object.keys(colors).length > 0 ||
    Object.values(styles).some((style) => style.color);
  const stylePatch = (key: string, next: ChartMarkStyle) =>
    Object.keys(next).length
      ? { ...styles, [key]: next }
      : withoutKey(styles, key);
  const resetColors = () => {
    const next = Object.fromEntries(
      Object.entries(styles).flatMap(([key, style]) => {
        const remaining = setMarkProperty(style, "color", undefined);
        return Object.keys(remaining).length ? [[key, remaining]] : [];
      }),
    );
    onChange({
      seriesColors: undefined,
      seriesStyles: Object.keys(next).length ? next : undefined,
    });
  };
  const message =
    (preparedSeries === undefined && spec.series && error?.id === result.id
      ? error.message
      : undefined) ?? prepared.error;
  const loading =
    preparing ||
    (preparedSeries === undefined &&
      Boolean(spec.series) &&
      snapshot?.id !== result.id &&
      !message);
  const seriesStatus = message ? (
    <div className="board-chart-colors-error" role="status">
      <p title={message}>Не удалось загрузить серии.</p>
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
  ) : null;
  const palette = chartPalette(spec);
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
        <summary>Стили серий</summary>
        {open && (
          <div className="board-chart-series-fields">
            {seriesStatus ?? (
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
                  {filtered.slice(0, limit).map((item) => {
                    const key = item.colorKey;
                    const style = styles[key] ?? {};
                    const invalidKey =
                      key.length > CHART_SERIES_COLOR_KEY_LIMIT;
                    const disabledStyle =
                      disabled ||
                      invalidKey ||
                      (atStyleLimit && !Object.hasOwn(styles, key));
                    // Old boards can store a color in seriesColors. The single color control
                    // edits the effective property, and resetting it clears either representation.
                    const useStyleColor =
                      style.color !== undefined || !Object.hasOwn(colors, key);
                    return (
                      <SeriesColor
                        key={key}
                        name={item.name}
                        color={item.color}
                        style={style}
                        custom={
                          style.color !== undefined ||
                          Object.hasOwn(colors, key)
                        }
                        disabled={
                          disabled ||
                          invalidKey ||
                          (useStyleColor && disabledStyle)
                        }
                        disabledStyle={disabledStyle}
                        changeStyle={(next) =>
                          onChange({ seriesStyles: stylePatch(key, next) })
                        }
                        onChange={(color) =>
                          onChange(
                            useStyleColor
                              ? {
                                  seriesStyles: stylePatch(key, {
                                    ...style,
                                    color,
                                  }),
                                }
                              : { seriesColors: { ...colors, [key]: color } },
                          )
                        }
                        onReset={() =>
                          onChange({
                            seriesColors: withoutKey(colors, key),
                            seriesStyles: stylePatch(
                              key,
                              setMarkProperty(style, "color", undefined),
                            ),
                          })
                        }
                        clearStyle={() =>
                          onChange({
                            seriesColors: withoutKey(colors, key),
                            seriesStyles: withoutKey(styles, key),
                          })
                        }
                      />
                    );
                  })}
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
                      : (spec.kind === "histogram" ? spec.x : spec.y.length)
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
            {atStyleLimit && <p>Достигнут предел в 5 000 стилей серий.</p>}
            {hasCustomColors && (
              <button
                type="button"
                className="board-chart-colors-clear"
                disabled={disabled}
                onClick={resetColors}
              >
                Вернуть цвета палитры
              </button>
            )}
          </div>
        )}
      </details>
      <details
        className="board-chart-series-colors"
        onToggle={(event) => setRulesOpen(event.currentTarget.open)}
      >
        <summary>Условное оформление</summary>
        {rulesOpen && (
          <div className="board-chart-series-fields">
            {seriesStatus}
            <ChartMarkRules
              spec={spec}
              columns={result.columns}
              series={series.filter(
                (s) => s.colorKey.length <= CHART_SERIES_COLOR_KEY_LIMIT,
              )}
              disabled={disabled}
              onChange={(markRules) => onChange({ markRules })}
            />
          </div>
        )}
      </details>
    </div>
  );
}
