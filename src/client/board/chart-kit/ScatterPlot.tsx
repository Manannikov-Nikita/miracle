import { isPanningPointer, svgLocalPoint } from "./svg-point";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { SkeletonMarks } from "../ChartSkeleton";
import { formatChartNumber } from "../chart-number";
import ChartTooltip from "./ChartTooltip";
import { useChartPaint } from "./mark-paint";
import { usePlotViewport } from "./compact-plot";
import { plotLoadingSeries, type ChartPlotProps } from "./plot-types";
import { scatterGeometry, scatterRadius } from "./scatter-geometry";
import { ScatterCloud, ScatterAxes } from "./ScatterLayers";
import "./scatter.css";

/** Bklit UI Scatter / StaticSeriesPointMarker (MIT, bklit/bklit-ui@76299da).
 * Each observation is a single positioned circle. A handful of entrance groups
 * fade in from left to right without allocating an animation per observation. */
export default function ScatterPlot(props: ChartPlotProps) {
  const { series, colors, columns, spec, label, loading } = props;
  const viewport = usePlotViewport();
  const paint = useChartPaint(series, colors);
  const width = viewport.width || 460,
    height = viewport.height || 240;
  const tipId = useId();
  const pointerDown = useRef(false);
  const [focus, setFocus] = useState<{ key: string; keyboard: boolean } | null>(
    null,
  );
  const g = useMemo(
    () => scatterGeometry({ series, colors, spec }, width, height),
    [series, colors, spec, width, height],
  );
  useEffect(() => {
    if (loading) setFocus(null);
  }, [loading]);
  const active = !loading && focus ? g.index.get(focus.key) : undefined;
  const kind = spec.numberFormat;
  const xName = columns.find((c) => c.id === spec.x)?.name ?? "X";
  const yName = spec.y
    .map((id) => columns.find((c) => c.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  const activeSeries = active && series[active.series],
    display = active && activeSeries?.displayData?.[active.index];
  return (
    <div
      ref={viewport.host}
      className="bk-cartesian bk-scatter"
      data-keyboard={focus?.keyboard || undefined}
    >
      <svg
        width="100%"
        height="100%"
        role="img"
        aria-label={label}
        aria-description={
          !loading && !g.points.length ? "Нет числовых пар X и Y" : undefined
        }
        aria-roledescription="точечный график"
        aria-describedby={active ? tipId : undefined}
        tabIndex={loading ? -1 : 0}
        viewBox={`0 0 ${width} ${height}`}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onPointerUp={() => {
          pointerDown.current = false;
        }}
        onPointerCancel={() => {
          pointerDown.current = false;
        }}
        onFocus={() => {
          if (!loading && !pointerDown.current && g.order[0])
            setFocus((prev) => prev ?? { key: g.order[0].key, keyboard: true });
        }}
        onBlur={() => {
          pointerDown.current = false;
          setFocus(null);
        }}
        onPointerLeave={() =>
          setFocus((prev) => (prev?.keyboard ? prev : null))
        }
        onPointerMove={(e) => {
          if (isPanningPointer(e.buttons)) {
            if (focus) setFocus(null);
            return;
          }
          if (loading) return;
          const cursor = svgLocalPoint(
            e.currentTarget,
            e.clientX,
            e.clientY,
            width,
            height,
          );
          const point = cursor && g.hit(cursor.x, cursor.y);
          setFocus((prev) =>
            point
              ? prev?.key === point.key && !prev.keyboard
                ? prev
                : { key: point.key, keyboard: false }
              : null,
          );
        }}
        onKeyDown={(e) => {
          if (loading || !g.order.length) return;
          let i = active ? (g.ranks.get(active.key) ?? 0) : 0;
          switch (e.key) {
            case "Home":
              i = 0;
              break;
            case "End":
              i = g.order.length - 1;
              break;
            case "ArrowRight":
            case "ArrowDown":
              i++;
              break;
            case "ArrowLeft":
            case "ArrowUp":
              i--;
              break;
            case "Escape":
              setFocus(null);
              e.preventDefault();
              e.stopPropagation();
              return;
            default:
              return;
          }
          e.preventDefault();
          e.stopPropagation();
          setFocus({
            key: g.order[Math.max(0, Math.min(g.order.length - 1, i))].key,
            keyboard: true,
          });
        }}
      >
        {paint.defs}
        <ScatterAxes
          g={g}
          width={width}
          height={height}
          xName={xName}
          yName={yName}
          spec={spec}
        />
        {loading ? (
          <SkeletonMarks
            spec={spec}
            series={plotLoadingSeries(series, colors)}
            count={g.points.length || undefined}
            x={g.left}
            y={g.top}
            width={g.right - g.left}
            height={g.bottom - g.top}
          />
        ) : (
          <g
            className="bk-scatter-cloud"
            data-dimmed={active ? true : undefined}
          >
            <ScatterCloud
              g={g}
              width={width}
              series={series}
              spec={spec}
              paint={paint}
            />
          </g>
        )}
        {!loading && !g.points.length && (
          <text
            className="bk-scatter-empty"
            x={(g.left + g.right) / 2}
            y={(g.top + g.bottom) / 2}
            textAnchor="middle"
          >
            Нет числовых пар X и Y
          </text>
        )}
        {active && (
          <g
            className="bk-scatter-focus"
            style={{ transform: `translate(${active.cx}px, ${active.cy}px)` }}
            aria-hidden="true"
            pointerEvents="none"
          >
            <circle
              r={scatterRadius + 3}
              fill="var(--bk-surface)"
              stroke={active.color}
              strokeWidth={1.5}
            />
            <circle
              r={scatterRadius}
              {...paint.fill(active.style, active.color)}
            />
          </g>
        )}
      </svg>
      {active && activeSeries && (
        <ChartTooltip
          id={tipId}
          motion={!focus?.keyboard}
          width={width}
          height={height}
          x={active.cx}
          y={active.cy}
          title={`${xName}: ${display?.x ?? formatChartNumber(active.x, kind)}`}
          rows={[
            {
              key: active.key,
              name: activeSeries.name,
              color: active.color,
              value: display?.value ?? formatChartNumber(active.y, kind),
              active: true,
            },
          ]}
        />
      )}
    </div>
  );
}
