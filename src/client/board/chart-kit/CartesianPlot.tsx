import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatChartNumber } from "../chartOptions";
import CartesianMarks from "./CartesianMarks";
import { cartesianGeometry, truncateTick } from "./cartesian-geometry";
import type { ChartPlotProps } from "./plot-types";

export default function CartesianPlot(props: ChartPlotProps) {
  const { spec, label, columns } = props;
  const [size, setSize] = useState({ width: 460, height: 240 });
  const [focus, setFocus] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const clip = useId();
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
  const active = focus !== null && focus < g.categories.length ? focus : null;
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
        aria-roledescription="график"
        tabIndex={0}
        onFocus={() => setFocus(0)}
        onBlur={() => setFocus(null)}
        onPointerLeave={() => setFocus(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const x = ((event.clientX - rect.left) * width) / rect.width;
          const y = ((event.clientY - rect.top) * height) / rect.height;
          if (x < g.left || x > g.right || y < g.top || y > g.bottom)
            return setFocus(null);
          setFocus(
            Math.min(
              g.categories.length - 1,
              Math.floor((g.horizontal ? y - g.top : x - g.left) / g.slot),
            ),
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
          if (event.key === "Escape") return setFocus(null);
          const delta =
            event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
          setFocus(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? g.categories.length - 1
                : Math.max(
                    0,
                    Math.min(g.categories.length - 1, (active ?? 0) + delta),
                  ),
          );
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
              i % categoryStride === 0 && (
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
        <g clipPath={`url(#${clip})`}>
          <CartesianMarks geometry={g} spec={spec} width={width} />
        </g>
        {active !== null && (
          <line
            className="bk-crosshair"
            x1={g.horizontal ? g.left : g.center(active)}
            x2={g.horizontal ? g.right : g.center(active)}
            y1={g.horizontal ? g.center(active) : g.top}
            y2={g.horizontal ? g.center(active) : g.bottom}
          />
        )}
      </svg>
      {active !== null && (
        <div
          className="bk-readout"
          data-side={
            !g.horizontal && g.center(active) > width / 2 ? "left" : "right"
          }
          role="status"
        >
          <strong>{g.categories[active]}</strong>
          {g.marks.map((m) => {
            const points = m.points.filter((p) => p.category === active);
            if (!points.length) return null;
            return (
              <div key={m.key}>
                <span className="bk-key" style={{ background: m.color }} />
                {m.name}
                <b>
                  {points
                    .map(
                      (p) =>
                        p.display ?? (p.value === null ? "—" : number(p.value)),
                    )
                    .join(", ")}
                </b>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
