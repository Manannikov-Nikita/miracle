import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatChartNumber } from "../chart-number";
import ChartTooltip from "./ChartTooltip";
import CartesianFocus from "./CartesianFocus";
import {
  focusColumns,
  pointerFocus,
  keyboardFocus,
  type PlotFocus,
  type Sample,
} from "./cartesian-focus";
import CartesianMarks from "./CartesianMarks";
import { cartesianGeometry, truncateTick } from "./cartesian-geometry";
import { plotLoadingSeries, type ChartPlotProps } from "./plot-types";
import { SkeletonMarks } from "../ChartSkeleton";

const noSamples: Sample[] = [];

export default function CartesianPlot(props: ChartPlotProps) {
  const { spec, label, columns, loading } = props;
  const [size, setSize] = useState({ width: 460, height: 240 });
  const [focus, setFocus] = useState<PlotFocus | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const clip = useId();
  const tooltipId = useId();
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = (width: number, height: number) => {
      if (width && height)
        setSize((prev) =>
          prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
    };
    // Start the bar entrance at the measured board size on the first paint.
    measure(el.clientWidth, el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        measure(
          Math.round(entry.contentRect.width),
          Math.round(entry.contentRect.height),
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
  useEffect(() => {
    if (loading) setFocus(null);
  }, [loading]);
  const active = !loading && focus && byCategory[focus.category] ? focus : null;
  const samples = active ? byCategory[active.category] : noSamples;
  const selected = active ? (samples[active.sample] ?? samples[0]) : undefined;
  const shared = spec.kind === "composed";
  const highlighted = useMemo(() => {
    if (shared) return samples.filter((sample) => sample.point.value !== null);
    return selected && selected.point.value !== null ? [selected] : noSamples;
  }, [shared, samples, selected]);
  // Keep comparisons anchored above the category even when the pointer crosses
  // another series within the same column.
  const anchor =
    shared && active && highlighted.length
      ? {
          x: g.center(active.category),
          y: Math.min(...highlighted.map((s) => s.y)),
        }
      : selected;
  const tooltipRows = useMemo(
    () =>
      samples.map((sample) => ({
        key: sample.key,
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
    <div
      className="bk-cartesian"
      ref={host}
      data-horizontal={g.horizontal}
      data-keyboard={keyboard || undefined}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        aria-describedby={active ? tooltipId : undefined}
        aria-roledescription="график"
        tabIndex={0}
        onFocus={() => {
          if (!focus) {
            setKeyboard(true);
            setFocus(keyboardFocus("Home", g, byCategory, null));
          }
        }}
        onBlur={() => setFocus(null)}
        onPointerLeave={() => setFocus(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const x = ((event.clientX - rect.left) * width) / rect.width;
          const y = ((event.clientY - rect.top) * height) / rect.height;
          setKeyboard(false);
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
          setKeyboard(true);
          setFocus((prev) => keyboardFocus(event.key, g, byCategory, prev));
        }}
      >
        {!loading && (
          <defs>
            <clipPath id={clip}>
              <rect className="bk-reveal" width={width} height={height} />
            </clipPath>
          </defs>
        )}
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
                  className="bk-category-tick"
                  data-inspected={i === active?.category || undefined}
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
        {loading ? (
          <SkeletonMarks
            x={g.left}
            y={g.top}
            width={g.right - g.left}
            height={g.bottom - g.top}
            count={g.categories.length}
            spec={spec}
            series={plotLoadingSeries(props.series, props.colors)}
            gridRows={
              spec.kind === "line" && spec.showGrid !== false
                ? g.ticks.map((t) => (g.scale(t) - g.top) / (g.bottom - g.top))
                : undefined
            }
            baseline={
              g.horizontal
                ? (g.zero - g.left) / (g.right - g.left)
                : (g.zero - g.top) / (g.bottom - g.top)
            }
          />
        ) : (
          <g
            className="bk-marks"
            data-dimmed={highlighted.length > 0}
            data-keyboard={keyboard || undefined}
            clipPath={`url(#${clip})`}
          >
            <CartesianMarks
              geometry={g}
              spec={spec}
              width={width}
              emphasizedBars={highlighted}
            />
          </g>
        )}
        {active && (
          <CartesianFocus
            g={g}
            category={active.category}
            shared={shared}
            highlighted={highlighted}
            width={width}
            height={height}
          />
        )}
      </svg>
      {active && (
        <ChartTooltip
          id={tooltipId}
          motion={!keyboard}
          x={anchor?.x ?? (g.horizontal ? g.zero : g.center(active.category))}
          y={anchor?.y ?? (g.horizontal ? g.center(active.category) : g.zero)}
          width={width}
          height={height}
          title={g.categories[active.category]}
          rows={tooltipRows}
        />
      )}
    </div>
  );
}
