// Bklit UI's heatmap rectangle layout and column-wave entrance, adapted for
// SQL categories and signed metrics. bklit/bklit-ui@76299da (MIT).
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatChartNumber } from "../chartOptions";
import type { ChartPlotProps } from "./plot-types";
import { metricText, usePlotViewport } from "./compact-plot";
import { heatmapRectCells } from "./bklit/heatmap-rect-cells";
import ChartTooltip from "./ChartTooltip";
import { unitPosition } from "./unit-position";
import "./compact-plots.css";

function shorten(value: string, pixels: number) {
  const count = Math.max(1, Math.floor(pixels / 7));
  return value.length <= count ? value : `${value.slice(0, count - 1)}…`;
}

export default function MatrixPlot({
  spec,
  series,
  colors,
  label,
  presentationBackground,
}: ChartPlotProps) {
  const focusMask = useId();
  const tooltipId = useId();
  const pointerInspection = useRef(false);
  const { host, width, height } = usePlotViewport();
  const [focus, setFocus] = useState<{
    col: number;
    row: number;
    pointer: boolean;
  } | null>(null);
  const { categories, bins, min, max } = useMemo(() => {
    const categories = series[0]?.xCategories ?? [
      ...new Set(series.flatMap((item) => item.data.map(([x]) => String(x)))),
    ];
    const lookup = series.map(
      (item) => new Map(item.data.map(([x], i) => [String(x), i])),
    );
    const values = series.flatMap((item) =>
      item.data.flatMap(([, value]) => (value === null ? [] : [value])),
    );
    const bins = categories.map((x) =>
      series.map((item, row) => {
        const index = lookup[row].get(x) ?? -1;
        return { index, value: item.data[index]?.[1] ?? undefined };
      }),
    );
    return {
      categories,
      bins,
      min: values.length ? Math.min(...values) : undefined,
      max: values.length ? Math.max(...values) : undefined,
    };
  }, [series]);
  const hasScale = spec.legend && min !== undefined && max !== undefined;
  const scaleHeight = hasScale ? 24 : 0;
  const xTitle = spec.showXAxis !== false && spec.xLabel?.trim();
  const yTitle = spec.showYAxis !== false && spec.yLabel?.trim();
  const labelWidth = spec.showYAxis !== false ? Math.min(100, width * 0.22) : 0;
  const left = labelWidth + (yTitle ? 16 : 0) + 5;
  const top = 4;
  const bottom =
    scaleHeight + (spec.showXAxis !== false ? 20 : 0) + (xTitle ? 15 : 0) + 4;
  const gridWidth = Math.max(1, width - left - 5);
  const gridHeight = Math.max(1, height - top - bottom);
  const columnSlot = gridWidth / Math.max(1, categories.length);
  const rowSlot = gridHeight / Math.max(1, series.length);
  // Keep a dense single row or column visible, even at subpixel bin widths.
  const cellSize = Math.max(16, Math.min(rowSlot, columnSlot));
  const xStep = Math.min(cellSize, columnSlot);
  const yStep = Math.min(cellSize, rowSlot);
  const gap = Math.min(2.5, xStep / 6, yStep / 6);
  const startX = left + (gridWidth - xStep * categories.length) / 2;
  const startY = top + (gridHeight - yStep * series.length) / 2;
  const cells = useMemo(
    () =>
      heatmapRectCells({
        data: bins,
        bins: (column) => column,
        count: (bin) => bin.value,
        binWidth: xStep,
        binHeight: yStep,
        gap,
        xScale: (column) => startX + column * xStep + gap / 2,
        yScale: (row) => startY + row * yStep - gap / 2,
      }),
    [bins, xStep, yStep, gap, startX, startY],
  );
  const svgCells = useMemo(
    () =>
      cells.map((column, col) => (
        <g
          key={categories[col]}
          className="matrix-column"
          style={{
            animationDelay: `${(col / Math.max(1, categories.length - 1)) * 480}ms`,
          }}
        >
          {column.map((cell) => {
            const row = cell.row;
            const item = series[row];
            const value = cell.count;
            const intensity =
              value === undefined || min === undefined || max === undefined
                ? 0
                : max === min
                  ? 0.8
                  : 0.2 + 0.8 * unitPosition(value, min, max);
            const fill =
              item.displayData?.[cell.bin.index]?.color ?? colors[row];
            const text = spec.showLabels
              ? metricText(item, cell.bin.index, spec.numberFormat)
              : "";
            const showValue =
              text && yStep >= 19 && text.length * 7 < xStep - 4;
            return (
              <g key={item.colorKey ?? row}>
                <rect
                  x={cell.x}
                  y={cell.y}
                  width={cell.width}
                  height={cell.height}
                  rx={Math.min(2, xStep / 6, yStep / 6)}
                  fill={value === undefined ? "none" : fill}
                  fillOpacity={intensity}
                  stroke={value === undefined ? "currentColor" : undefined}
                  strokeOpacity={0.25}
                  strokeWidth={Math.min(1, cell.width / 4)}
                />
                {showValue && (
                  <text
                    className="matrix-value"
                    x={cell.x + cell.width / 2}
                    y={cell.y + cell.height / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    paintOrder="stroke"
                    stroke={
                      presentationBackground ?? "var(--board-bg, #202123)"
                    }
                    strokeWidth={2.5}
                  >
                    {text}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )),
    [
      cells,
      categories,
      colors,
      max,
      min,
      series,
      spec.showLabels,
      spec.numberFormat,
      xStep,
      yStep,
      presentationBackground,
    ],
  );
  const active = focus && cells[focus.col]?.[focus.row];
  const item = active && series[active.row];
  const titleFor = (col: number) =>
    series[0]?.categoryLabels?.[categories[col]] ?? categories[col];
  const xLabelStride = Math.max(1, Math.ceil(60 / xStep));
  const yLabelStride = Math.max(1, Math.ceil(15 / yStep));
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    let col = focus?.col ?? 0,
      row = focus?.row ?? 0;
    switch (event.key) {
      case "ArrowLeft":
        col--;
        break;
      case "ArrowRight":
        col++;
        break;
      case "ArrowUp":
        row--;
        break;
      case "ArrowDown":
        row++;
        break;
      case "Home":
        col = 0;
        break;
      case "End":
        col = categories.length - 1;
        break;
      case "Escape":
        setFocus(null);
        event.stopPropagation();
        return;
      default:
        return;
    }
    pointerInspection.current = false;
    event.preventDefault();
    event.stopPropagation();
    setFocus({
      pointer: false,
      col: Math.max(0, Math.min(categories.length - 1, col)),
      row: Math.max(0, Math.min(series.length - 1, row)),
    });
  };
  return (
    <div
      ref={host}
      className="matrix-plot"
      data-pointer={focus?.pointer || undefined}
    >
      {width > 0 && height > 0 && (
        <svg
          role="img"
          aria-roledescription="Тепловая карта"
          aria-label={label}
          aria-describedby={active ? tooltipId : undefined}
          tabIndex={0}
          width="100%"
          height="100%"
          viewBox={`0 0 ${width} ${height}`}
          onKeyDown={onKeyDown}
          onFocus={() =>
            setFocus(
              (previous) => previous ?? { col: 0, row: 0, pointer: false },
            )
          }
          onBlur={() => {
            pointerInspection.current = false;
            setFocus(null);
          }}
          onPointerDown={() => {
            pointerInspection.current = true;
          }}
          onPointerLeave={() => {
            if (pointerInspection.current) setFocus(null);
            pointerInspection.current = false;
          }}
          onPointerMove={(event) => {
            pointerInspection.current = true;
            const rect = event.currentTarget.getBoundingClientRect();
            const col = Math.floor(
              (((event.clientX - rect.left) / rect.width) * width - startX) /
                xStep,
            );
            const row = Math.floor(
              (((event.clientY - rect.top) / rect.height) * height - startY) /
                yStep,
            );
            if (
              col >= 0 &&
              row >= 0 &&
              col < categories.length &&
              row < series.length
            )
              setFocus((previous) =>
                previous?.col === col &&
                previous.row === row &&
                previous.pointer
                  ? previous
                  : { col, row, pointer: true },
              );
            else setFocus(null);
          }}
        >
          {active && (
            <defs>
              <mask
                id={focusMask}
                maskUnits="userSpaceOnUse"
                x={0}
                y={0}
                width={width}
                height={height}
                style={{ maskType: "alpha" }}
              >
                <rect
                  width={width}
                  height={height}
                  fill="white"
                  fillOpacity={0.68}
                />
                <rect
                  x={active.x}
                  y={active.y}
                  width={active.width}
                  height={active.height}
                  fill="white"
                />
              </mask>
            </defs>
          )}
          <g mask={active ? `url(#${focusMask})` : undefined}>{svgCells}</g>
          {spec.showYAxis !== false &&
            series.map(
              (item, row) =>
                row % yLabelStride === 0 && (
                  <text
                    key={item.colorKey ?? row}
                    x={startX - 5}
                    y={startY + (row + 0.5) * yStep}
                    textAnchor="end"
                    dominantBaseline="central"
                    className="matrix-tick"
                  >
                    {shorten(item.name, labelWidth)}
                  </text>
                ),
            )}
          {spec.showXAxis !== false &&
            categories.map(
              (category, col) =>
                col % xLabelStride === 0 && (
                  <text
                    key={category}
                    x={startX + (col + 0.5) * xStep}
                    y={startY + series.length * yStep + 13}
                    textAnchor="middle"
                    className="matrix-tick"
                  >
                    {shorten(
                      titleFor(col),
                      Math.min(90, xStep * xLabelStride - 3),
                    )}
                  </text>
                ),
            )}
          {xTitle && (
            <text
              x={left + gridWidth / 2}
              y={height - scaleHeight - 4}
              textAnchor="middle"
              className="matrix-tick"
            >
              {shorten(xTitle, gridWidth)}
            </text>
          )}
          {yTitle && (
            <text
              transform={`translate(12,${top + gridHeight / 2}) rotate(-90)`}
              textAnchor="middle"
              className="matrix-tick"
            >
              {shorten(yTitle, gridHeight)}
            </text>
          )}
          {active && (
            <g
              style={{ transform: `translate(${active.x}px, ${active.y}px)` }}
              className="matrix-focus"
              pointerEvents="none"
              fill="none"
            >
              <rect
                width={active.width}
                height={active.height}
                rx={Math.min(2, active.width / 4, active.height / 4)}
                stroke={presentationBackground ?? "var(--board-bg, #202124)"}
                strokeWidth={3.5}
              />
              <rect
                width={active.width}
                height={active.height}
                rx={Math.min(2, active.width / 4, active.height / 4)}
                stroke="currentColor"
                strokeWidth={1.6}
              />
            </g>
          )}
        </svg>
      )}
      {hasScale && (
        <div className="matrix-scale" aria-label="Шкала интенсивности">
          <span>{formatChartNumber(min!, spec.numberFormat)}</span>
          {min !== max && (
            <>
              <i
                aria-hidden="true"
                style={{ color: colors.length === 1 ? colors[0] : undefined }}
              />
              <span>{formatChartNumber(max!, spec.numberFormat)}</span>
            </>
          )}
        </div>
      )}
      {active && item && (
        <ChartTooltip
          id={tooltipId}
          motion={focus?.pointer}
          x={active.x + active.width / 2}
          y={active.y + active.height / 2}
          width={width}
          height={height}
          title={
            active.bin.index >= 0
              ? (item.displayData?.[active.bin.index]?.x ??
                titleFor(active.column))
              : titleFor(active.column)
          }
          rows={[
            {
              key: item.colorKey ?? String(active.row),
              name: item.name,
              value: metricText(item, active.bin.index, spec.numberFormat),
              color:
                item.displayData?.[active.bin.index]?.color ??
                colors[active.row],
              active: true,
            },
          ]}
        />
      )}
    </div>
  );
}
