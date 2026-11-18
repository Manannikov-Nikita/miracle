// Adapted from the Bklit UI LineSparkline (bklit/bklit-ui@76299da, MIT).
import { memo, useMemo, useState } from "react";
import type { ChartSeriesItem } from "../model";
import type { ChartPlotProps } from "./plot-types";
import { trendLine } from "./bklit/trend-line";
import { categoryText, metricText, usePlotViewport } from "./compact-plot";
import "./compact-plots.css";

const TrendRow = memo(function TrendRow({
  item,
  spec,
  color,
  label,
  width,
  height,
}: {
  item: ChartSeriesItem;
  spec: ChartPlotProps["spec"];
  color: string;
  label: string;
  width: number;
  height: number;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const last = item.data.length - 1;
  const active = focus === null || last < 0 ? null : Math.min(focus, last);
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
  const valueText = (index: number) =>
    metricText(item, index, spec.numberFormat);
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
  return (
    <div className="trend-row" style={{ height }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        tabIndex={0}
        aria-label={`${label} · ${item.name}`}
        aria-roledescription="Спарклайн"
        onFocus={() => setFocus((current) => current ?? 0)}
        onBlur={() => setFocus(null)}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (!bounds.width || !points.length) return;
          const x = ((event.clientX - bounds.left) / bounds.width) * width;
          setFocus(
            Math.max(
              0,
              Math.min(
                last,
                Math.round(((x - 5) / Math.max(1, width - 10)) * last),
              ),
            ),
          );
        }}
        onPointerLeave={(event) => {
          if (event.currentTarget !== document.activeElement) setFocus(null);
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
              setFocus(null);
              event.stopPropagation();
              return;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          setFocus(Math.min(last, Math.max(0, next)));
        }}
      >
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
        {point && (
          <line
            x1={point.x}
            x2={point.x}
            y1={0}
            y2={height}
            stroke="currentColor"
            opacity={0.55}
            strokeDasharray="3 3"
          />
        )}
        {point && Number.isFinite(point.y) && (
          <circle
            cx={point.x}
            cy={point.y}
            r={3.5}
            fill={item.displayData?.[active!]?.color ?? color}
          />
        )}
      </svg>
      {active === null && spec.showLabels && last >= 0 && (
        <span className="trend-latest">{valueText(last)}</span>
      )}
      {active !== null && (
        <output className="compact-plot-readout" aria-live="polite">
          <span>{item.name}</span>
          <span>{categoryText(item, active)}</span>
          <strong>{valueText(active)}</strong>
        </output>
      )}
    </div>
  );
});

export default function TrendPlot({
  spec,
  series,
  colors,
  label,
}: ChartPlotProps) {
  const { host, width, height } = usePlotViewport();
  const rowHeight = Math.max(
    30,
    Math.floor(height / Math.max(1, series.length)) - 4,
  );
  return (
    <div className="trend-plot nowheel" ref={host}>
      {width > 0 &&
        height > 0 &&
        series.map((item, index) => (
          <TrendRow
            key={item.colorKey ?? index}
            item={item}
            spec={spec}
            color={colors[index]}
            label={label}
            width={width}
            height={rowHeight}
          />
        ))}
    </div>
  );
}
