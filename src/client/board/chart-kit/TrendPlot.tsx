import { isPanningPointer } from "./svg-point";
// Adapted from the Bklit UI LineSparkline (bklit/bklit-ui@76299da, MIT).
import {
  Fragment,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { curveMonotoneX } from "d3-shape";
import { createPortal } from "react-dom";
import type { ChartSeriesItem } from "../model";
import type { ChartPlotProps } from "./plot-types";
import { trendLine } from "./bklit/trend-line";
import { categoryText, metricText, usePlotViewport } from "./compact-plot";
import ChartTooltip from "./ChartTooltip";
import { SkeletonMarks } from "../ChartSkeleton";
import { pointAppearance } from "./point-appearance";
import { useChartPaint } from "./mark-paint";
import { styledPathRuns } from "./styled-path";
import "./compact-plots.css";

interface Selection {
  key: string;
  index: number;
  pointer: boolean;
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
  pointerMotion,
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
  pointerMotion: boolean;
  setSelection: React.Dispatch<React.SetStateAction<Selection | null>>;
  tooltipHost: HTMLDivElement | null;
  viewportHeight: number;
  offset: number;
}) {
  const clip = useId();
  const reveal = useId();
  const strokes = useId();
  const rowItems = useMemo(() => [item], [item]);
  const rowColors = useMemo(() => [color], [color]);
  const paint = useChartPaint(rowItems, rowColors);
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
  const { style: activeStyle, color: ink } = pointAppearance(
    item,
    active ?? -1,
    color,
  );
  const valueText = (index: number) =>
    metricText(item, index, spec.numberFormat);
  const choose = (index: number) => {
    const pointer = pointerInspection.current;
    setSelection((prev) =>
      prev?.key === rowKey && prev.index === index && prev.pointer === pointer
        ? prev
        : { key: rowKey, index, pointer },
    );
  };
  const clear = () =>
    setSelection((prev) => (prev?.key === rowKey ? null : prev));
  const customized = Boolean(item.seriesStyle || item.pointStyles);
  const marks = useMemo(() => {
    const data = points.map((p, i) => ({
      ...p,
      value: item.data[i][1],
      ...(customized
        ? pointAppearance(item, i, color)
        : { color, style: undefined }),
    }));
    const runs = customized
      ? styledPathRuns(
          data,
          curveMonotoneX,
          (p) => p.x,
          (p) => p.y,
        )
      : [{ stroke: path, color, style: undefined }];
    return (
      <>
        <g
          id={strokes}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {runs.map((run, i) => {
            const outline = paint.outline(run.style, run.color, 2);
            return (
              <Fragment key={i}>
                {outline && <path d={run.stroke} {...outline} />}
                <path
                  className="trend-line"
                  data-styled={customized || undefined}
                  d={run.stroke}
                  pathLength={customized ? undefined : 1}
                  {...paint.line(run.style, run.color, 2)}
                />
              </Fragment>
            );
          })}
        </g>
        {data.map((p, i) => {
          // Keep isolated measurements and conditionally marked observations visible.
          const single =
            !Number.isFinite(points[i - 1]?.y) &&
            !Number.isFinite(points[i + 1]?.y);
          if (p.value === null || (!single && !item.pointStyles?.[i]))
            return null;
          return (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={single ? 2 : 2.5}
              {...paint.fill(p.style, p.color)}
            />
          );
        })}
      </>
    );
  }, [item, color, points, path, paint, customized, strokes]);
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
      data-pointer={pointerMotion || undefined}
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
          if (isPanningPointer(event.buttons)) {
            if (active !== null) clear();
            return;
          }
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
        {paint.defs}
        {customized && (
          <defs>
            <clipPath id={reveal}>
              <rect className="trend-reveal" width={width} height={height} />
            </clipPath>
          </defs>
        )}
        <g
          className="trend-context"
          clipPath={customized ? `url(#${reveal})` : undefined}
        >
          {marks}
        </g>
        {point && (
          <g pointerEvents="none">
            <defs>
              <clipPath id={clip}>
                <rect
                  className="trend-highlight-window"
                  x={-highlightWidth / 2}
                  style={{ transform: `translateX(${point.x}px)` }}
                  y={0}
                  width={highlightWidth}
                  height={height}
                />
              </clipPath>
            </defs>
            {customized ? (
              <use href={`#${strokes}`} clipPath={`url(#${clip})`} />
            ) : (
              <path
                d={path}
                clipPath={`url(#${clip})`}
                strokeWidth={2.5}
                fill="none"
                stroke={color}
                strokeLinecap="round"
              />
            )}
            <line
              className="trend-guide"
              x1={0}
              x2={0}
              style={{ transform: `translateX(${point.x}px)` }}
              y1={1}
              y2={height - 1}
            />
            {Number.isFinite(point.y) && (
              <g
                className="trend-marker"
                style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
              >
                <circle r={6} fill={ink} fillOpacity={0.23} />
                <circle
                  r={4.25}
                  fill="var(--bk-surface, #202124)"
                  stroke="currentColor"
                  strokeWidth={1.2}
                />
                <circle r={2.5} {...paint.fill(activeStyle, ink)} />
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
            motion={pointerMotion}
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
  loading,
}: ChartPlotProps) {
  const { host, width, height } = usePlotViewport();
  const overlay = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    if (loading) setSelection(null);
  }, [loading]);
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
            const offset = index * (rowHeight + 4) - scrollTop;
            if (loading) {
              return (
                <div
                  key={key}
                  className="trend-row"
                  style={{ height: rowHeight }}
                >
                  {offset < height && offset + rowHeight > 0 && (
                    <SkeletonMarks
                      spec={spec}
                      count={item.data.length}
                      series={[
                        {
                          metricId: item.metricId,
                          color: colors[index],
                          index,
                        },
                      ]}
                      width="100%"
                      height={rowHeight}
                    />
                  )}
                </div>
              );
            }
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
                pointerMotion={selected && selection.pointer}
                setSelection={setSelection}
                tooltipHost={overlay.current}
                viewportHeight={height}
                offset={selected ? offset : 0}
              />
            );
          })}
      </div>
    </div>
  );
}
