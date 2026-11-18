import { memo, type CSSProperties } from "react";
import type { ChartSpec } from "../../../shared/types";
import type { cartesianGeometry } from "./cartesian-geometry";
import { formatChartNumber } from "../chartOptions";
import { LinePath } from "./bklit/line-path";
import { truncateTick } from "./cartesian-geometry";

export default memo(function CartesianMarks({
  geometry: g,
  spec,
  width,
}: {
  geometry: ReturnType<typeof cartesianGeometry>;
  spec: ChartSpec;
  width: number;
}) {
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
                  style={
                    {
                      "--bk-delay": `${Math.min(180, (i * 180) / m.points.length)}ms`,
                      transformOrigin: g.horizontal
                        ? `${zero}px 0`
                        : `0 ${zero}px`,
                    } as CSSProperties
                  }
                  x={g.horizontal ? Math.min(zero, v) : start}
                  y={g.horizontal ? start : Math.min(zero, v)}
                  width={g.horizontal ? length : g.barWidth}
                  height={g.horizontal ? g.barWidth : length}
                  rx={Math.min(3, g.barWidth / 3, length / 2)}
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
});
