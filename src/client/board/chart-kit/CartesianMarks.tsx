import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import type { ChartSpec } from "../../../shared/types";
import type { cartesianGeometry } from "./cartesian-geometry";
import { formatChartNumber } from "../chartOptions";
import { barRect, type Sample } from "./cartesian-focus";
import "./hover-bar.css";
import { LinePath } from "./bklit/line-path";
import { truncateTick } from "./cartesian-geometry";

export default memo(function CartesianMarks({
  geometry: g,
  spec,
  width,
  emphasizedBars,
}: {
  geometry: ReturnType<typeof cartesianGeometry>;
  spec: ChartSpec;
  width: number;
  emphasizedBars: readonly Sample[];
}) {
  // Index the real rectangles once. Pointer inspection touches only bars that
  // enter or leave focus, retaining their position, animation and point colors.
  const bars = useRef(new WeakMap<Sample["point"], SVGRectElement>());
  const previous = useRef(new Set<SVGRectElement>());
  useLayoutEffect(() => {
    const next = new Set<SVGRectElement>();
    for (const sample of emphasizedBars) {
      const rect = bars.current.get(sample.point);
      if (rect) next.add(rect);
    }
    for (const rect of previous.current) {
      if (!next.has(rect)) rect.classList.remove("bk-active-bar");
    }
    for (const rect of next) {
      if (!previous.current.has(rect)) rect.classList.add("bk-active-bar");
    }
    previous.current = next;
  }, [emphasizedBars, g]);

  return useMemo(() => {
    const number = (v: number) => formatChartNumber(v, spec.numberFormat);
    const zero = g.zero;
    return g.marks.map((m) => {
      const inside = spec.labelPosition === "inside" && m.style === "bar";
      return (
        <g key={m.key} data-series-style={m.style}>
          {m.fill && <path d={m.fill} fill={m.color} fillOpacity=".18" />}
          {m.stroke && (
            <LinePath
              className="bk-line"
              d={m.stroke}
              fill="none"
              stroke={m.color}
              strokeWidth="2.4"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {m.points.map((p, i) => {
            if (p.value === null) return null;
            const pos = g.center(p.category);
            const v = g.scale(p.value);
            const start = pos + m.offset;
            const length = Math.abs(v - zero);
            const color = p.color ?? m.color;
            const text = p.display ?? number(p.value);
            const drawLabel =
              spec.showLabels &&
              g.slot >= (g.horizontal ? 13 : 20) &&
              (!inside || length >= (g.horizontal ? text.length * 7 : 14));
            const dx = p.value < 0 ? -1 : 1;
            const labelX = g.horizontal
              ? inside
                ? (v + zero) / 2
                : v + dx * 4
              : m.style === "bar"
                ? start + g.barWidth / 2
                : pos;
            const labelY = g.horizontal
              ? start + g.barWidth / 2 + 3
              : inside
                ? (v + zero) / 2 + 4
                : v + (p.value < 0 ? 12 : -5);
            return (
              <g key={i}>
                {m.style === "bar" ? (
                  <rect
                    className="bk-bar"
                    ref={(el) => {
                      if (el) bars.current.set(p, el);
                      else bars.current.delete(p);
                    }}
                    style={
                      {
                        "--bk-delay": `${Math.min(180, (i * 180) / m.points.length)}ms`,
                        transformOrigin: g.horizontal
                          ? `${zero}px 0`
                          : `0 ${zero}px`,
                      } as CSSProperties
                    }
                    {...barRect(g, start, v)}
                    fill={color}
                  />
                ) : (
                  (p.color ||
                    m.points.length < 70 ||
                    (m.points[i - 1]?.value == null &&
                      m.points[i + 1]?.value == null)) && (
                    <circle cx={pos} cy={v} r="2.5" fill={color} />
                  )
                )}
                {drawLabel && (
                  <text
                    className={inside ? "bk-inside" : "bk-value"}
                    x={labelX}
                    y={labelY}
                    textAnchor={
                      g.horizontal && !inside
                        ? dx < 0
                          ? "end"
                          : "start"
                        : "middle"
                    }
                  >
                    {truncateTick(text, g.horizontal ? width * 0.14 : g.slot)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      );
    });
  }, [g, spec, width]);
});
