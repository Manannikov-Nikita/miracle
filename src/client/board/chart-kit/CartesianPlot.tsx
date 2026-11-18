import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatChartNumber } from "../chartOptions";
import ChartTooltip from "./ChartTooltip";
import CartesianFocus from "./CartesianFocus";
import {
  focusColumns,
  pointerFocus,
  keyboardFocus,
  type PlotFocus,
} from "./cartesian-focus";
import CartesianMarks from "./CartesianMarks";
import { cartesianGeometry, truncateTick } from "./cartesian-geometry";
import type { ChartPlotProps } from "./plot-types";

export default function CartesianPlot(props: ChartPlotProps) {
  const { spec, label, columns } = props;
  const [size, setSize] = useState({ width: 460, height: 240 });
  const [focus, setFocus] = useState<PlotFocus | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const clip = useId();
  const tooltipId = useId();
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0),
        h = Math.round(entry?.contentRect.height ?? 0);
      if (w && h)
        setSize((prev) =>
          prev.width === w && prev.height === h
            ? prev
            : { width: w, height: h },
        );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const g = useMemo(
    () => cartesianGeometry(props, size.width, size.height),
    [props.spec, props.series, props.colors, size],
  );
  const number = (v: number) => formatChartNumber(v, spec.numberFormat);
  const categoryStride = Math.max(
    1,
    Math.ceil((g.horizontal ? 22 : 66) / g.slot),
  );
  const byCategory = useMemo(() => focusColumns(g), [g]);
  const active = focus && byCategory[focus.category] ? focus : null;
  const samples = active ? byCategory[active.category] : [];
  const selected = active ? (samples[active.sample] ?? samples[0]) : undefined;
  const tooltipRows = useMemo(
    () =>
      samples.map((sample, index) => ({
        key: `${sample.mark.key}:${index}`,
        name: sample.mark.name,
        color: sample.color,
        value:
          sample.point.display ??
          (sample.point.value === null
            ? "—"
            : formatChartNumber(sample.point.value, spec.numberFormat)),
        active: sample === selected,
      })),
    [samples, selected, spec.numberFormat],
  );
  const { width, height } = size;
  const categoryTitle = columns.find((c) => c.id === spec.x)?.name;
  const metricTitle = spec.y
    .map((id) => columns.find((c) => c.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  const nameX = g.horizontal ? metricTitle : categoryTitle;
  const nameY = g.horizontal ? categoryTitle : metricTitle;
  return (
    <div className="bk-cartesian" ref={host} data-horizontal={g.horizontal}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        aria-describedby={active ? tooltipId : undefined}
        aria-roledescription="график"
        tabIndex={0}
        onFocus={() =>
          setFocus(
            (current) => current ?? keyboardFocus("Home", g, byCategory, null),
          )
        }
        onBlur={() => setFocus(null)}
        onPointerLeave={() => setFocus(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const x = ((event.clientX - rect.left) * width) / rect.width;
          const y = ((event.clientY - rect.top) * height) / rect.height;
          const next = pointerFocus(g, byCategory, x, y);
          setFocus((prev) =>
            prev?.category === next?.category && prev?.sample === next?.sample
              ? prev
              : next,
          );
        }}
        onKeyDown={(event) => {
          if (
            ![
              "Home",
              "End",
              "Escape",
              "ArrowRight",
              "ArrowLeft",
              "ArrowDown",
              "ArrowUp",
            ].includes(event.key)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          setFocus((prev) => keyboardFocus(event.key, g, byCategory, prev));
        }}
      >
        <defs>
          <clipPath id={clip}>
            <rect className="bk-reveal" width={width} height={height} />
          </clipPath>
        </defs>
        {g.ticks.map((t) => (
          <g key={t}>
            {spec.showGrid !== false && (
              <line
                className="bk-grid"
                x1={g.horizontal ? g.scale(t) : g.left}
                x2={g.horizontal ? g.scale(t) : g.right}
                y1={g.horizontal ? g.top : g.scale(t)}
                y2={g.horizontal ? g.bottom : g.scale(t)}
              />
            )}
            {(g.horizontal ? g.showX : g.showY) && (
              <text
                x={g.horizontal ? g.scale(t) : g.left - 5}
                y={
                  g.horizontal ? g.bottom + g.bottomGutter + 14 : g.scale(t) + 3
                }
                textAnchor={g.horizontal ? "middle" : "end"}
              >
                {truncateTick(number(t), g.horizontal ? 56 : g.left - 10)}
              </text>
            )}
          </g>
        ))}
        {(g.horizontal ? g.showY : g.showX) &&
          g.categories.map(
            (name, i) =>
              i % categoryStride === 0 &&
              i !== active?.category && (
                <text
                  key={i}
                  x={g.horizontal ? g.axisLeft - 5 : g.center(i)}
                  y={
                    g.horizontal
                      ? g.center(i) + 3
                      : g.bottom + g.bottomGutter + 14
                  }
                  textAnchor={g.horizontal ? "end" : "middle"}
                >
                  {truncateTick(
                    name,
                    g.horizontal ? g.axisLeft - 18 : g.slot * categoryStride,
                  )}
                  <title>{name}</title>
                </text>
              ),
          )}
        {g.showX && height >= 100 && (
          <text
            className="bk-axis-name"
            x={(g.left + g.right) / 2}
            y={height - 3}
            textAnchor="middle"
          >
            {truncateTick(nameX || "", g.right - g.left)}
          </text>
        )}
        {g.showY && width >= 210 && (
          <text
            className="bk-axis-name"
            transform={`translate(10 ${(g.top + g.bottom) / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {truncateTick(nameY || "", g.bottom - g.top)}
          </text>
        )}
        <g
          className="bk-marks"
          data-dimmed={!!selected && selected.point.value !== null}
          clipPath={`url(#${clip})`}
        >
          <CartesianMarks geometry={g} spec={spec} width={width} />
        </g>
        {active && (
          <CartesianFocus
            g={g}
            category={active.category}
            sample={selected}
            width={width}
            height={height}
          />
        )}
      </svg>
      {active && (
        <ChartTooltip
          id={tooltipId}
          x={selected?.x ?? (g.horizontal ? g.zero : g.center(active.category))}
          y={selected?.y ?? (g.horizontal ? g.center(active.category) : g.zero)}
          width={width}
          height={height}
          title={g.categories[active.category]}
          rows={tooltipRows}
        />
      )}
    </div>
  );
}
