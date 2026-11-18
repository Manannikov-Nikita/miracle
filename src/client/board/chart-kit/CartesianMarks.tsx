import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import type { ChartSpec } from "../../../shared/types";
import type { cartesianGeometry } from "./cartesian-geometry";
import { formatChartNumber } from "../chart-number";
import { barRect, type Sample } from "./cartesian-focus";
import "./hover-bar.css";
import StackedBarMarks from "./StackedBarMarks";
import type { useChartPaint } from "./mark-paint";
import { LinePath } from "./bklit/line-path";
import { truncateTick } from "./cartesian-geometry";

export default memo(function CartesianMarks({
  geometry: g,
  spec,
  width,
  emphasizedBars,
  paint,
}: {
  geometry: ReturnType<typeof cartesianGeometry>;
  spec: ChartSpec;
  width: number;
  emphasizedBars: readonly Sample[];
  paint: ReturnType<typeof useChartPaint>;
}) {
  // Index the real rectangles once. Pointer inspection touches only bars that
  // enter or leave focus, retaining their position, animation and point colors.
  const bars = useRef(new WeakMap<Sample["point"], SVGGraphicsElement>());
  const register = useCallback(
    (point: Sample["point"], node: SVGGraphicsElement | null) => {
      if (node) bars.current.set(point, node);
      else bars.current.delete(point);
    },
    [],
  );
  const seriesGroups = useRef(new Map<string, SVGGElement>());
  useLayoutEffect(() => {
    const selected = emphasizedBars[0]?.mark;
    if (spec.kind === "composed" || !selected || selected.style === "bar")
      return;
    const group = seriesGroups.current.get(selected.key);
    group?.classList.add("bk-active-series");
    return () => group?.classList.remove("bk-active-series");
  }, [emphasizedBars, spec.kind, g]);
  const previous = useRef(new Set<SVGGraphicsElement>());
  useLayoutEffect(() => {
    const next = new Set<SVGGraphicsElement>();
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
    if (g.stacked && spec.kind === "bar")
      return (
        <StackedBarMarks
          g={g}
          spec={spec}
          width={width}
          register={register}
          paint={paint}
        />
      );
    const number = (v: number) => formatChartNumber(v, spec.numberFormat);
    const zero = g.zero;
    return g.marks.map((m) => {
      const inside = spec.labelPosition === "inside" && m.style === "bar";
      const hasLabels = !!spec.showLabels && g.slot >= (g.horizontal ? 13 : 20);
      return (
        <g
          key={m.key}
          data-series-style={m.style}
          ref={(el) => {
            if (el) seriesGroups.current.set(m.key, el);
            else seriesGroups.current.delete(m.key);
          }}
        >
          {(
            m.parts ?? [
              {
                stroke: m.stroke,
                fill: m.fill,
                style: m.seriesStyle,
                color: m.color,
              },
            ]
          ).map((part, index) => {
            if (!part.stroke && !part.fill) return null;
            const outline = paint.outline(part.style, part.color);
            return (
              <Fragment key={index}>
                {part.fill && (
                  <path
                    d={part.fill}
                    className="bk-area-fill"
                    fillOpacity={g.stacked ? 0.38 : 0.18}
                    {...paint.fill(part.style, part.color)}
                    stroke="none"
                  />
                )}
                {part.stroke && outline && (
                  <LinePath
                    className="bk-line-outline"
                    d={part.stroke}
                    fill="none"
                    strokeLinejoin="round"
                    {...outline}
                  />
                )}
                {part.stroke && (
                  <LinePath
                    className="bk-line"
                    d={part.stroke}
                    fill="none"
                    strokeLinejoin="round"
                    {...paint.line(part.style, part.color)}
                  />
                )}
              </Fragment>
            );
          })}
          {m.points.map((p, i) => {
            if (p.value === null) return null;
            const marker =
              m.style !== "bar" &&
              (p.keepMarker ||
                m.points.length < 70 ||
                (m.points[i - 1]?.value == null &&
                  m.points[i + 1]?.value == null));
            if (m.style !== "bar" && !marker && !hasLabels) return null;
            const pos = g.center(p.category);
            const v = p.endPx;
            const start = pos + m.offset;
            const length = Math.abs(v - zero);
            const color = p.color ?? m.color;
            const text = hasLabels ? (p.display ?? number(p.value)) : "";
            const drawLabel =
              hasLabels &&
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
              <Fragment key={i}>
                {m.style === "bar" ? (
                  <rect
                    className="bk-bar"
                    ref={(el) => {
                      register(p, el);
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
                    {...paint.fill(p.style, color)}
                  />
                ) : (
                  marker && (
                    <circle
                      cx={pos}
                      cy={v}
                      r="2.5"
                      {...paint.fill(p.style, color)}
                    />
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
              </Fragment>
            );
          })}
        </g>
      );
    });
  }, [g, spec, width, register, paint]);
});
