import { isPanningPointer, svgLocalPoint } from "./svg-point";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { presentationColors } from "../presentation-colors";
import { SkeletonMarks } from "../ChartSkeleton";
import { usePlotViewport } from "./compact-plot";
import { truncateTick } from "./cartesian-geometry";

import {
  binPath,
  histogramGeometry,
  histogramRange,
} from "./histogram-display";
import { plotLoadingSeries, type ChartPlotProps } from "./plot-types";
import ChartTooltip from "./ChartTooltip";
import { useChartPaint } from "./mark-paint";
import { pointAppearance } from "./point-appearance";
import "./histogram.css";

const countText = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Numeric, adjacent frequency intervals as in shadcn.io histogram-default,
 * histogram-overlay and histogram-stacked. Values are already binned by Miracle. */
export default function HistogramPlot(props: ChartPlotProps) {
  const { spec, series, colors, columns, loading, label } = props;
  const viewport = usePlotViewport();
  const paint = useChartPaint(series, colors);
  const width = viewport.width || 460,
    height = viewport.height || 240;
  const g = useMemo(
    () => histogramGeometry({ spec, series }, width, height),
    [series, spec, width, height],
  );
  const tipId = useId();
  const pointerDown = useRef(false);
  const [focus, setFocus] = useState<{
    index: number;
    keyboard: boolean;
  } | null>(null);
  useEffect(() => {
    if (loading) setFocus(null);
  }, [loading]);
  const active = !loading && focus ? g.columns[focus.index] : undefined;
  const groupRefs = useRef<(SVGGElement | null)[]>([]);
  useLayoutEffect(() => {
    if (!active || !focus) return;
    const element = groupRefs.current[focus.index];
    element?.setAttribute("data-active", "true");
    return () => element?.removeAttribute("data-active");
  }, [active, focus]);
  const cloud = useMemo(
    () =>
      g.columns.map((col, i) => {
        const gap = Math.min(2, (col.x1 - col.x0) * 0.12),
          w = col.x1 - col.x0 - gap;
        let stack = 0;
        const highest = col.counts.reduce(
          (last, v, j) => (v > 0 ? j : last),
          -1,
        );
        const used: number[] = [];
        return (
          <g
            className="bk-histogram-bin"
            ref={(el) => {
              groupRefs.current[i] = el;
            }}
            key={col.bin.lower}
            data-bin={i}
            data-lower={col.bin.lower}
            data-upper={col.bin.upper}
            style={
              {
                "--bin-delay": `${(i * 250) / g.columns.length}ms`,
                transformOrigin: `0 ${g.bottom}px`,
              } as CSSProperties
            }
          >
            {col.counts.map((count, j) => {
              if (count <= 0) return null;
              const from = g.stacked ? stack : 0;
              if (g.stacked) stack += count;
              const y = g.y(from + count),
                h = g.y(from) - y;
              const { style, color } = pointAppearance(series[j], i, colors[j]);
              const text = countText.format(count);
              const labelY = g.stacked ? (g.y(from) + y) / 2 : y - 4;
              const fits =
                spec.showLabels &&
                text.length * 6 + 3 < w &&
                (!g.stacked || h >= 15) &&
                !used.some((pos) => Math.abs(pos - labelY) < 13);
              if (fits) used.push(labelY);
              return (
                <g key={series[j].colorKey ?? j}>
                  <path
                    className="bk-histogram-bar"
                    data-bin={i}
                    data-count={count}
                    data-series={j}
                    fillOpacity={spec.series && !g.stacked ? 0.55 : 1}
                    {...paint.fill(style, color)}
                    d={binPath(
                      col.x0 + gap / 2,
                      y,
                      w,
                      h,
                      !g.stacked || j === highest,
                    )}
                  />
                  {fits && (
                    <text
                      className={
                        g.stacked
                          ? "bk-inside bk-histogram-label"
                          : "bk-value bk-histogram-label"
                      }
                      style={
                        g.stacked
                          ? {
                              fill: presentationColors(color).text,
                              stroke: "none",
                            }
                          : undefined
                      }
                      x={col.center}
                      y={labelY}
                      textAnchor="middle"
                      dominantBaseline={g.stacked ? "central" : "auto"}
                    >
                      {text}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      }),
    [g, series, colors, paint, spec.showLabels, spec.series],
  );
  const axisName = columns.find((c) => c.id === spec.x)?.name ?? spec.x;
  const empty = !g.columns.length && !loading;
  const select = (i: number, keyboard: boolean) =>
    setFocus((prev) =>
      prev?.index === i && prev.keyboard === keyboard
        ? prev
        : { index: i, keyboard },
    );
  return (
    <div
      className="bk-cartesian bk-histogram"
      ref={viewport.host}
      data-keyboard={focus?.keyboard || undefined}
    >
      <svg
        role="img"
        aria-label={label}
        aria-roledescription="гистограмма"
        aria-describedby={active ? tipId : undefined}
        aria-description={
          empty ? "Нет числовых значений для гистограммы" : undefined
        }
        tabIndex={loading ? -1 : 0}
        width="100%"
        height="100%"
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
          if (!loading && !pointerDown.current && g.columns.length && !focus)
            select(0, true);
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
          const p = svgLocalPoint(
            e.currentTarget,
            e.clientX,
            e.clientY,
            width,
            height,
          );
          const i = p && g.hit(p.x, p.y);
          if (i !== null) select(i, false);
          else setFocus(null);
        }}
        onKeyDown={(e) => {
          if (loading || !g.columns.length) return;
          let i = focus?.index ?? 0;
          switch (e.key) {
            case "ArrowRight":
            case "ArrowDown":
              i++;
              break;
            case "ArrowLeft":
            case "ArrowUp":
              i--;
              break;
            case "Home":
              i = 0;
              break;
            case "End":
              i = g.columns.length - 1;
              break;
            case "Escape":
              if (!active) return;
              setFocus(null);
              e.preventDefault();
              e.stopPropagation();
              return;
            default:
              return;
          }
          e.preventDefault();
          e.stopPropagation();
          select(Math.max(0, Math.min(g.columns.length - 1, i)), true);
        }}
      >
        {paint.defs}
        {!empty &&
          g.yTicks.map((t) => (
            <g key={t}>
              {spec.showGrid !== false && (
                <line
                  className="bk-grid"
                  x1={g.left}
                  x2={g.right}
                  y1={g.y(t)}
                  y2={g.y(t)}
                />
              )}
              {g.showY && (
                <text
                  className="bk-histogram-tick-y"
                  x={g.left - 6}
                  y={g.y(t) + 3}
                  textAnchor="end"
                >
                  {countText.format(t)}
                </text>
              )}
            </g>
          ))}
        {g.showX &&
          !empty &&
          g.xTicks.map(({ x, label: t, value }) => {
            const abbreviated = truncateTick(
              t,
              Math.min(
                90,
                (g.right - g.left) / Math.max(1, g.xTicks.length - 1),
              ),
            );
            const room = abbreviated.length * 3.5 + 1;
            return (
              <text
                key={value}
                className="bk-histogram-tick-x"
                x={Math.max(room, Math.min(width - room, x))}
                y={g.bottom + 14}
                textAnchor="middle"
              >
                {abbreviated}
                {abbreviated !== t && <title>{t}</title>}
              </text>
            );
          })}
        {g.showX && !empty && height >= 100 && (
          <text
            className="bk-axis-name"
            x={(g.left + g.right) / 2}
            y={height - 3}
            textAnchor="middle"
          >
            {truncateTick(axisName, g.right - g.left)}
          </text>
        )}
        {g.showY && !empty && width >= 210 && (
          <text
            className="bk-axis-name"
            transform={`translate(10 ${(g.top + g.bottom) / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            Частота
          </text>
        )}
        {loading ? (
          <SkeletonMarks
            spec={spec}
            count={g.columns.length || spec.binCount}
            series={plotLoadingSeries(series, colors)}
            x={g.columns[0]?.x0 ?? g.left}
            y={g.top}
            width={
              (g.columns.at(-1)?.x1 ?? g.right) - (g.columns[0]?.x0 ?? g.left)
            }
            height={g.bottom - g.top}
          />
        ) : (
          <g
            className="bk-histogram-distribution"
            data-inspecting={active ? true : undefined}
          >
            {cloud}
          </g>
        )}
        {empty && (
          <text
            className="bk-histogram-empty"
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
          >
            Нет числовых значений для гистограммы
          </text>
        )}
        {active && (
          <g
            className="bk-histogram-guide"
            style={{ transform: `translateX(${active.center}px)` }}
            aria-hidden="true"
          >
            <line
              className="bk-crosshair"
              x1={0}
              x2={0}
              y1={g.top}
              y2={g.bottom}
            />
          </g>
        )}
      </svg>
      {active && focus && (
        <ChartTooltip
          id={tipId}
          motion={!focus.keyboard}
          width={width}
          height={height}
          x={active.center}
          y={g.y(active.peak)}
          title={histogramRange(
            active.bin,
            focus.index === g.columns.length - 1,
            spec.numberFormat,
          )}
          rows={series.map((s, j) => ({
            key: s.colorKey ?? String(j),
            name: s.name,
            color: pointAppearance(s, focus.index, colors[j]).color,
            value: countText.format(active.counts[j]),
          }))}
        />
      )}
    </div>
  );
}
