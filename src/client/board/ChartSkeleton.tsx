import { useId, useState, type ReactNode, type SVGAttributes } from "react";
import {
  chartSeriesColor,
  chartSeriesColorKey,
  composedMetricStyle,
} from "../../shared/chart-appearance";
import type { ChartSpec } from "../../shared/types";
import {
  LoadingBars,
  LoadingCurve,
  LoadingMatrix,
  LoadingPoints,
  type LoadingSeries,
} from "./chart-kit/loading-marks";

export interface ChartSkeletonProps {
  spec?: ChartSpec;
  series?: readonly LoadingSeries[];
  count?: number;
  baseline?: number;
  gap?: number;
  gridRows?: readonly number[];
}

type Viewport = Pick<
  SVGAttributes<SVGSVGElement>,
  "x" | "y" | "width" | "height"
>;

// The 17-stop sin² mask, tilt and travel match Bklit UI's loading-sweep.tsx.
const stops = Array.from({ length: 17 }, (_, index) => ({
  offset: index / 16,
  opacity: 0.05 + 0.85 * Math.sin((index / 16) * Math.PI) ** 2,
}));

function LoadingSweep({ children }: { children: (pass: number) => ReactNode }) {
  const id = useId();
  const [pass, setPass] = useState(0);
  return (
    <>
      <defs>
        <linearGradient id={`${id}-band`}>
          {stops.map(({ offset, opacity }) => (
            <stop
              key={offset}
              offset={offset}
              stopColor="white"
              stopOpacity={opacity}
            />
          ))}
        </linearGradient>
        <mask
          id={id}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          <g className="chart-skeleton-tilt">
            <rect
              className="chart-skeleton-sweep"
              y="-100%"
              width="100%"
              height="300%"
              fill={`url(#${id}-band)`}
              onAnimationIteration={() => setPass((n) => n + 1)}
            />
          </g>
        </mask>
      </defs>
      <g className="chart-skeleton-swept" mask={`url(#${id})`}>
        {children(pass)}
      </g>
    </>
  );
}

const defaultGridRows = [0, 0.25, 0.5, 0.75, 1];

function LineGridGlint({ rows }: { rows: readonly number[] }) {
  const id = useId();
  return (
    <g className="chart-skeleton-glint">
      <defs>
        <linearGradient id={`${id}-light`}>
          <stop stopColor="currentColor" stopOpacity="0" />
          <stop offset=".5" stopColor="currentColor" stopOpacity=".26" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
        <mask
          id={id}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          {rows.map((y, i) => (
            <line
              key={i}
              x1="0"
              x2="100%"
              y1={`${y * 100}%`}
              y2={`${y * 100}%`}
              stroke="white"
              strokeDasharray="3 4"
            />
          ))}
        </mask>
      </defs>
      <g mask={`url(#${id})`}>
        <rect width="38%" height="100%" fill={`url(#${id}-light)`} />
      </g>
    </g>
  );
}

function loadingSeries(spec?: ChartSpec): LoadingSeries[] {
  const ids = spec?.y.length ? spec.y : [undefined];
  // Before the first result the metrics are known, the breakdown values aren't.
  // Two illustrative groups make a split or stacked layout visible without
  // inventing group labels or assigning a real group's custom color.
  const groups = spec?.series ? 2 : 1;
  return ids.flatMap((metricId, i) =>
    Array.from({ length: groups }, (_, j) => ({
      metricId,
      color: chartSeriesColor(
        spec ?? {},
        {
          colorKey:
            metricId && !spec?.series
              ? chartSeriesColorKey(metricId, undefined, undefined)
              : undefined,
        },
        i * groups + j,
      ),
    })),
  );
}

export function SkeletonMarks({
  spec,
  series = loadingSeries(spec),
  count,
  gap,
  baseline,
  gridRows = defaultGridRows,
  ...viewport
}: ChartSkeletonProps & Viewport) {
  const kind = spec?.kind ?? "bar";
  const horizontal = kind === "bar" && spec?.orientation === "horizontal";
  const zero = baseline ?? (horizontal ? 0 : 1);
  const rows = series.length;
  const n = Math.max(1, count ?? (kind === "heatmap" ? 12 : 8));
  // Cold metadata is the source table's size, before filters or chart limits.
  // Only MatrixPlot knows the actual post-transform grid.
  const matrixColumns =
    typeof viewport.width === "number" ? n : Math.min(32, n);
  const styles = series.map((item, i) => {
    const mark =
      kind === "composed" && spec
        ? composedMetricStyle(spec, item.metricId ?? spec.y[i] ?? spec.y[0])
        : kind;
    return { ...item, index: item.index ?? i, mark };
  });

  // A sample of each series style keeps dense overlaid placeholders legible.
  const stackedBar = kind === "bar" && !!spec?.series && !!spec.stacked;
  const barSeries = styles.filter((s) => s.mark === "bar");
  const bars = stackedBar ? barSeries : barSeries.slice(0, 6);
  const areas = styles.filter((s) => s.mark === "area").slice(0, 4);
  const lines = styles.filter((s) => s.mark === "line").slice(0, 4);
  const scatter = styles.filter((s) => s.mark === "scatter").slice(0, 6);

  return (
    <svg
      {...viewport}
      className="chart-skeleton"
      data-kind={kind}
      data-orientation={horizontal ? "horizontal" : "vertical"}
      aria-hidden="true"
      focusable="false"
    >
      {kind === "line" && spec?.showGrid !== false && (
        <LineGridGlint rows={gridRows} />
      )}
      {kind === "heatmap" && rows > 0 && (
        <LoadingMatrix
          columns={matrixColumns}
          rows={rows}
          width={viewport.width}
          height={viewport.height}
          gap={gap}
        />
      )}
      {kind === "sparkline" &&
        styles.map(({ color, index }, row) => (
          <svg
            key={row}
            y={`${(100 * row) / rows}%`}
            height={`${100 / rows}%`}
            width="100%"
          >
            <LoadingCurve kind="sparkline" color={color} index={index} />
          </svg>
        ))}
      {(areas.length > 0 || bars.length > 0 || scatter.length > 0) && (
        <LoadingSweep>
          {(pass) => (
            <>
              {areas.map(({ color, index }) => (
                <LoadingCurve
                  key={index}
                  kind="area"
                  color={color}
                  index={index}
                  pass={pass}
                  baseline={zero}
                />
              ))}
              {bars.length > 0 && (
                <LoadingBars
                  series={bars}
                  count={n}
                  pass={pass}
                  horizontal={horizontal}
                  baseline={zero}
                  stacked={stackedBar}
                  metricOrder={spec?.y}
                  plotLength={horizontal ? viewport.height : viewport.width}
                />
              )}
              {scatter.length > 0 && (
                <LoadingPoints series={scatter} count={n} />
              )}
            </>
          )}
        </LoadingSweep>
      )}
      {lines.map(({ color, index }) => (
        <LoadingCurve key={index} kind="line" color={color} index={index} />
      ))}
    </svg>
  );
}

export default function ChartSkeleton(props: ChartSkeletonProps) {
  const kind = props.spec?.kind;
  const horizontal = kind === "bar" && props.spec?.orientation === "horizontal";
  const grid =
    props.spec?.showGrid !== false &&
    kind !== "sparkline" &&
    kind !== "heatmap";
  return (
    <div
      className="chart-skeleton-frame"
      data-kind={kind ?? "bar"}
      aria-hidden="true"
    >
      {grid && (
        <svg className="chart-skeleton-grid" width="100%" height="100%">
          {defaultGridRows.map((row) => (
            <line
              key={row}
              x1={horizontal ? `${row * 100}%` : 0}
              x2={horizontal ? `${row * 100}%` : "100%"}
              y1={horizontal ? 0 : `${row * 100}%`}
              y2={horizontal ? "100%" : `${row * 100}%`}
            />
          ))}
          {kind === "scatter" &&
            defaultGridRows.map((row) => (
              <line
                key={row}
                x1={`${100 * row}%`}
                x2={`${100 * row}%`}
                y1="0"
                y2="100%"
              />
            ))}
        </svg>
      )}
      <SkeletonMarks {...props} width="100%" height="100%" />
    </div>
  );
}
