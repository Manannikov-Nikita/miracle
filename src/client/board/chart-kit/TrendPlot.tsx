// Adapted from the Bklit UI LineSparkline (bklit/bklit-ui@76299da, MIT).
import { memo, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChartSeriesItem } from "../model";
import type { ChartPlotProps } from "./plot-types";
import { trendLine } from "./bklit/trend-line";
import { categoryText, metricText, usePlotViewport } from "./compact-plot";
import ChartTooltip from "./ChartTooltip";
import "./compact-plots.css";

interface Selection {
  key: string;
  index: number;
}

const TrendRow = memo(function TrendRow({
  item,
  spec,
  color,
  label,
  width,
  height,
  rowKey,
  activeIndex,
  setSelection,
  tooltipHost,
  viewportHeight,
  offset,
}: {
  item: ChartSeriesItem;
  spec: ChartPlotProps["spec"];
  color: string;
  label: string;
  width: number;
  height: number;
  rowKey: string;
  activeIndex: number | null;
  setSelection: React.Dispatch<React.SetStateAction<Selection | null>>;
  tooltipHost: HTMLDivElement | null;
  viewportHeight: number;
  offset: number;
}) {
  const clip = useId();
  const tooltipId = useId();
  const pointerInspection = useRef(false);
  const last = item.data.length - 1;
  const active =
    activeIndex === null || last < 0 ? null : Math.min(activeIndex, last);
  const { points, path } = useMemo(
    () =>
      trendLine(
        item.data.map((point) => point[1]),
        width,
        height,
      ),
    [item.data, width, height],
  );
  const point = active === null ? undefined : points[active];
  const ink = (active !== null && item.displayData?.[active]?.color) || color;
  const valueText = (index: number) =>
    metricText(item, index, spec.numberFormat);
  const choose = (index: number) =>
    setSelection((prev) =>
      prev?.key === rowKey && prev.index === index
        ? prev
        : { key: rowKey, index },
    );
  const clear = () =>
    setSelection((prev) => (prev?.key === rowKey ? null : prev));
  // SVG strokes skip isolated defined points between gaps. Keep those points visible.
  const singles = useMemo(
    () =>
      points.filter(
        (p, i) =>
          Number.isFinite(p.y) &&
          !Number.isFinite(points[i - 1]?.y) &&
          !Number.isFinite(points[i + 1]?.y),
      ),
    [points],
  );
  const highlightWidth = Math.min(width, Math.max(24, width * 0.16));
  const anchorY =
    offset + (point && Number.isFinite(point.y) ? point.y : height / 2);
  const tooltipVisible =
    active !== null &&
    point &&
    tooltipHost &&
    anchorY >= 0 &&
    anchorY <= viewportHeight;
  return (
    <div
      className="trend-row"
      style={{ height }}
      data-active={active !== null || undefined}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        tabIndex={0}
        aria-label={`${label} · ${item.name}`}
        aria-roledescription="Спарклайн"
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        onFocus={() => choose(active ?? 0)}
        onBlur={() => {
          pointerInspection.current = false;
          clear();
        }}
        onPointerDown={() => {
          pointerInspection.current = true;
        }}
        onPointerMove={(event) => {
          pointerInspection.current = true;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (!bounds.width || !points.length) return;
          const x = ((event.clientX - bounds.left) / bounds.width) * width;
          choose(
            Math.max(
              0,
              Math.min(
                last,
                Math.round(((x - 5) / Math.max(1, width - 10)) * last),
              ),
            ),
          );
        }}
        onPointerLeave={() => {
          if (pointerInspection.current) clear();
          pointerInspection.current = false;
        }}
        onKeyDown={(event) => {
          let next = active ?? 0;
          switch (event.key) {
            case "ArrowLeft":
              next--;
              break;
            case "ArrowRight":
              next++;
              break;
            case "Home":
              next = 0;
              break;
            case "End":
              next = last;
              break;
            case "Escape":
              clear();
              event.stopPropagation();
              return;
            default:
              return;
          }
          pointerInspection.current = false;
          event.preventDefault();
          event.stopPropagation();
          choose(Math.min(last, Math.max(0, next)));
        }}
      >
        <g className="trend-context">
          <path
            className="trend-line"
            d={path}
            pathLength={1}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {singles.map((p) => (
            <circle key={p.x} cx={p.x} cy={p.y} r={2} fill={color} />
          ))}
        </g>
        {point && (
          <g pointerEvents="none">
            <defs>
              <clipPath id={clip}>
                <rect
                  x={point.x - highlightWidth / 2}
                  y={0}
                  width={highlightWidth}
                  height={height}
                />
              </clipPath>
            </defs>
            <path
              d={path}
              clipPath={`url(#${clip})`}
              strokeWidth={2.5}
              fill="none"
              stroke={color}
              strokeLinecap="round"
            />
            <line
              className="trend-guide"
              x1={point.x}
              x2={point.x}
              y1={1}
              y2={height - 1}
            />
            {Number.isFinite(point.y) && (
              <g
                className="trend-marker"
                transform={`translate(${point.x} ${point.y})`}
              >
                <circle r={6} fill={ink} fillOpacity={0.23} />
                <circle
                  r={4.25}
                  fill="var(--bk-surface, #202124)"
                  stroke="currentColor"
                  strokeWidth={1.2}
                />
                <circle r={2.5} fill={ink} />
              </g>
            )}
          </g>
        )}
      </svg>
      {active === null && spec.showLabels && last >= 0 && (
        <span className="trend-latest">{valueText(last)}</span>
      )}
      {tooltipVisible &&
        createPortal(
          <ChartTooltip
            id={tooltipId}
            x={point.x}
            y={anchorY}
            width={width}
            height={viewportHeight}
            title={categoryText(item, active)}
            rows={[
              {
                key: rowKey,
                name: item.name,
                value: valueText(active),
                color: ink,
                active: true,
              },
            ]}
          />,
          tooltipHost,
        )}
    </div>
  );
});

export default function TrendPlot({
  spec,
  series,
  colors,
  label,
  presentationBackground,
}: ChartPlotProps) {
  const { host, width, height } = usePlotViewport();
  const overlay = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = Math.max(
    30,
    Math.floor(height / Math.max(1, series.length)) - 4,
  );
  return (
    <div
      ref={overlay}
      className="trend-plot"
      style={
        {
          "--bk-surface": presentationBackground ?? "#202124",
        } as React.CSSProperties
      }
    >
      <div
        ref={host}
        className="trend-scroll nowheel"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {width > 0 &&
          height > 0 &&
          series.map((item, index) => {
            const key = item.colorKey ?? String(index);
            const selected = selection?.key === key;
            return (
              <TrendRow
                key={key}
                rowKey={key}
                item={item}
                spec={spec}
                color={colors[index]}
                label={label}
                width={width}
                height={rowHeight}
                activeIndex={selected ? selection.index : null}
                setSelection={setSelection}
                tooltipHost={overlay.current}
                viewportHeight={height}
                offset={selected ? index * (rowHeight + 4) - scrollTop : 0}
              />
            );
          })}
      </div>
    </div>
  );
}
