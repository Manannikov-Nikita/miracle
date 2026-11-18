import { curveNatural } from "d3-shape";
import { useId } from "react";
import { areaClosedD, linePathD } from "./bklit/line-path";

// Adapted from Bklit UI's loading-sweep, line-loading-pulse and heatmap-cells
// (MIT, bklit/bklit-ui@76299da). All geometry is illustrative while loading.
function fractionAt(index: number, seed = 0) {
  const value = Math.sin((index + 1) * 12.9898 + seed) * 43758.5453;
  return value - Math.floor(value);
}

export interface LoadingSeries {
  metricId?: string;
  color: string;
  index?: number;
}

export function LoadingCurve({
  kind,
  color,
  index,
  pass = 0,
  baseline = 1,
}: {
  kind: "line" | "area" | "sparkline";
  color: string;
  index: number;
  pass?: number;
  baseline?: number;
}) {
  const id = useId();
  const filled = kind === "area";
  const points = Array.from({ length: filled ? 14 : 7 }, (_, i) =>
    filled
      ? 23 + fractionAt(i, pass + index * 1.7) * 54
      : 68 - Math.sin(i * 1.15 + index * 1.7) * 20 - i * 3,
  );
  const path = {
    x: (_value: number, i: number) => (100 * i) / (points.length - 1),
    y: (value: number) => value,
    curve: curveNatural,
  };
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <g
        className={filled ? undefined : "chart-skeleton-pulse"}
        data-skeleton-mark={kind}
      >
        {filled && (
          <>
            <defs>
              <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                <stop stopColor={color} stopOpacity=".28" />
                <stop offset="1" stopColor={color} stopOpacity=".045" />
              </linearGradient>
            </defs>
            <path
              d={areaClosedD(points, { ...path, y0: baseline * 100 })}
              fill={`url(#${id})`}
            />
          </>
        )}
        <path
          d={linePathD(points, path)}
          fill="none"
          stroke={color}
          strokeOpacity={filled ? 0.65 : 0.72}
          strokeWidth={kind === "sparkline" ? 2 : 2.5}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

export function LoadingBars({
  series,
  count,
  horizontal,
  baseline,
  pass,
  stacked,
}: {
  series: LoadingSeries[];
  count: number;
  horizontal: boolean;
  baseline: number;
  pass: number;
  stacked: boolean;
}) {
  const slots = Math.max(1, Math.min(count, 64));
  const slot = 100 / slots;
  const groupWidth = slot * 0.7;
  // As in chartOptions, each metric has its own stack of breakdowns.
  const stacks = new Map<string | number, LoadingSeries[]>();
  series.forEach((item, j) => {
    const key = stacked ? (item.metricId ?? j) : j;
    const lane = stacks.get(key);
    if (lane) lane.push(item);
    else stacks.set(key, [item]);
  });
  const lanes = [...stacks.values()];
  const laneWidth = groupWidth / lanes.length;
  return (
    <g data-skeleton-mark="bar" fillOpacity=".45">
      {Array.from({ length: slots }, (_, i) => {
        const towardStart = baseline === 1 || (baseline > 0 && i % 2 === 0);
        const room = towardStart ? baseline : 1 - baseline;
        return lanes.map((lane, col) => {
          let stack = 0;
          const cross = (i + 0.15) * slot + laneWidth * col;
          const width = laneWidth * (lanes.length > 1 ? 0.9 : 1);
          return lane.map(({ color }, j) => {
            const seed = pass + col * 1.7 + j * 2.3;
            const fraction = (20 + Math.floor(fractionAt(i, seed) * 60)) / 100;
            const length = (fraction * room * 100) / lane.length;
            const origin = baseline * 100 + (towardStart ? -stack : stack);
            const start = towardStart ? origin - length : origin;
            stack += length;
            return (
              <rect
                key={`${i}-${col}-${j}`}
                rx="2"
                fill={color}
                x={`${horizontal ? start : cross}%`}
                y={`${horizontal ? cross : start}%`}
                width={`${horizontal ? length : width}%`}
                height={`${horizontal ? width : length}%`}
              />
            );
          });
        });
      })}
    </g>
  );
}

export function LoadingPoints({
  series,
  count,
}: {
  series: LoadingSeries[];
  count: number;
}) {
  // Distribute each cloud over two numeric axes; coordinates stay fixed as light passes.
  const n = Math.min(36, Math.max(6, count));
  return series.map(({ color }, j) => (
    <g key={j} fill={color} fillOpacity=".6" data-skeleton-mark="point">
      {Array.from({ length: n }, (_, i) => {
        const x = (i + 0.3 + 0.4 * fractionAt(i, j)) / n;
        const y = 0.68 - 0.36 * x + (fractionAt(i, j + 3) - 0.5) * 0.52;
        return <circle key={i} cx={`${x * 100}%`} cy={`${y * 100}%`} r="3.5" />;
      })}
    </g>
  ));
}

export function LoadingMatrix({
  columns,
  rows,
  width,
  height,
  gap,
}: {
  columns: number;
  rows: number;
  width?: number | string;
  height?: number | string;
  gap?: number;
}) {
  // Retained data gives us the exact MatrixPlot viewport and gap. Before the
  // first snapshot, fit a grid of square cells to the available space.
  const w = typeof width === "number" ? width : columns * 18;
  const h = typeof height === "number" ? height : rows * 18;
  const dx = w / columns,
    dy = h / rows;
  const gutter = gap ?? Math.min(2, dx / 6, dy / 6);
  // Share a small number of offset animation clocks on dense maps (up to 5000
  // cells). Their locations are scattered, so neighbouring cells pulse separately.
  const total = rows * columns;
  const phases: number[][] = Array.from(
    { length: Math.min(32, total) },
    () => [],
  );
  for (let i = 0; i < total; i++)
    phases[Math.floor(fractionAt(i, 3) * phases.length)].push(i);
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`}>
      <g
        data-skeleton-mark="cell"
        fill="var(--bk-muted, var(--board-muted, #9299a4))"
      >
        {phases.map((cells, j) => {
          const seed = fractionAt(j);
          return (
            <g
              key={j}
              className="chart-skeleton-cell"
              opacity={0.15 + 0.38 * seed}
              style={{
                animationDuration: `${5 + seed * 4.4}s`,
                animationDelay: `${-9 * fractionAt(j, 5)}s`,
              }}
            >
              {cells.map((i) => (
                <rect
                  key={i}
                  x={(i % columns) * dx + gutter / 2}
                  y={Math.floor(i / columns) * dy + gutter / 2}
                  width={dx - gutter}
                  height={dy - gutter}
                  rx={Math.min(2, dx / 4, dy / 4)}
                />
              ))}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
