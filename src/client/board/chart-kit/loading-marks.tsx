import { curveBumpX, curveNatural } from "d3-shape";
import { useId } from "react";
import { binPath } from "./histogram-display";
import { splitSignedArea, type BandPoint } from "./stacked-area";
import { seriesBarLayout } from "./cartesian-geometry";
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
  band,
}: {
  kind: "line" | "area" | "sparkline";
  color: string;
  index: number;
  pass?: number;
  baseline?: number;
  band?: BandPoint[];
}) {
  const id = useId();
  const filled = kind === "area";
  const samples = filled ? 14 : 7;
  const points =
    (band && filled ? splitSignedArea(band) : band) ??
    Array.from({ length: samples }, (_, i) => ({
      category: (100 * i) / (samples - 1),
      value: 0,
      base: baseline * 100,
      end: filled
        ? 23 + fractionAt(i, pass + index * 1.7) * 54
        : 68 - Math.sin(i * 1.15 + index * 1.7) * 20 - i * 3,
    }));
  const path = {
    x: (p: (typeof points)[number]) => p.category,
    defined: (p: (typeof points)[number]) => p.value !== null,
    y: (p: (typeof points)[number]) => p.end,
    curve: band ? curveBumpX : curveNatural,
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
        data-stacked={band ? true : undefined}
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
              d={areaClosedD(points, { ...path, y0: (p) => p.base })}
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

/** Illustrative layers use the chart's baseline, category centres and metric groups. */
export function LoadingStackedCurves({
  kind,
  series,
  count,
  baseline,
  pass = 0,
}: {
  kind: "line" | "area";
  series: LoadingSeries[];
  count: number;
  baseline: number;
  pass?: number;
}) {
  const groups = new Map<string | undefined, LoadingSeries[]>();
  for (const layer of series) {
    const group = groups.get(layer.metricId) ?? [];
    // Keep the loading silhouette readable for high-cardinality breakdowns.
    if (group.length < 6) group.push(layer);
    groups.set(layer.metricId, group);
  }
  const samples = Math.max(2, Math.min(14, count));
  const margin = count > 1 ? 50 / count : 10;
  return [...groups.values()].map((layers, metric) => {
    const positive = Array<number>(samples).fill(baseline);
    const negative = Array<number>(samples).fill(baseline);
    const mixed = baseline > 0 && baseline < 1;
    return layers.map((layer, i) => {
      const band = Array.from({ length: samples }, (_, col) => {
        const above =
          baseline === 1 ||
          (mixed && (layers.length === 1 ? col < samples / 2 : i % 2 === 0));
        const endpoints = above ? positive : negative;
        const slots =
          mixed && layers.length > 1
            ? above
              ? Math.ceil(layers.length / 2)
              : Math.floor(layers.length / 2)
            : layers.length;
        const share = (above ? -baseline : 1 - baseline) / slots;
        const variation =
          (Math.sin(col * 0.9 + i * 1.2 + metric + pass) + 1) / 2;
        const base = endpoints[col];
        const end = base + share * (0.34 + 0.51 * variation);
        endpoints[col] = end;
        return {
          category: margin + ((100 - 2 * margin) * col) / (samples - 1),
          value: base - end,
          oppositeBase: 100 * (above ? negative[col] : positive[col]),
          base: 100 * base,
          end: 100 * end,
        };
      });
      return (
        <LoadingCurve
          key={layer.index ?? i}
          kind={kind}
          color={layer.color}
          index={layer.index ?? i}
          band={band}
        />
      );
    });
  });
}

export function LoadingBars({
  series,
  count,
  horizontal,
  baseline,
  pass,
  stacked,
  plotLength,
  metricOrder,
}: {
  series: LoadingSeries[];
  count: number;
  horizontal: boolean;
  baseline: number;
  pass: number;
  stacked: boolean;
  plotLength?: number | string;
  metricOrder?: readonly string[];
}) {
  const slots = Math.max(1, Math.min(count, 64));
  const slot = 100 / slots;
  // Each metric gets a separate stack of breakdowns.
  const stacks = new Map<string | number, LoadingSeries[]>();
  series.forEach((item, j) => {
    const key = stacked ? (item.metricId ?? j) : j;
    const lane = stacks.get(key);
    if (lane) lane.push(item);
    else stacks.set(key, [item]);
  });
  // The saved metric order still applies when the legend hides early breakdowns.
  const order = new Set<string | number>([
    ...(stacked ? (metricOrder ?? []) : []),
    ...stacks.keys(),
  ]);
  const lanes = [...order].flatMap((key) => {
    const lane = stacks.get(key);
    return lane ? [lane] : [];
  });
  const pixelSlot =
    typeof plotLength === "number" && plotLength > 0 ? plotLength / slots : 0;
  // Once a chart has data, keep the same widths and category centres through a refresh.
  const layout =
    stacked && pixelSlot > 0 ? seriesBarLayout(pixelSlot, lanes.length) : null;
  const groupWidth = layout
    ? (layout.groupWidth / pixelSlot) * slot
    : slot * 0.7;
  const step = layout
    ? ((layout.width + layout.gap) / pixelSlot) * slot
    : groupWidth / lanes.length;
  const width = layout
    ? (layout.width / pixelSlot) * slot
    : step * (lanes.length > 1 ? 0.9 : 1);
  // On dense breakdowns sample the colors within each metric, retaining every stack.
  const perLane = Math.max(
    2,
    Math.min(6, Math.floor(768 / (slots * lanes.length))),
  );
  return (
    <g data-skeleton-mark="bar" fillOpacity=".45">
      {Array.from({ length: slots }, (_, i) => {
        const towardStart = baseline === 1 || (baseline > 0 && i % 2 === 0);
        const room = towardStart ? baseline : 1 - baseline;
        return lanes.map((lane, col) => {
          let stack = 0;
          const cross = (i + 0.5) * slot - groupWidth / 2 + step * col;
          const segments = lane.slice(0, perLane);
          return segments.map(({ color }, j) => {
            const seed = pass + col * 1.7 + j * 2.3;
            const fraction = (20 + Math.floor(fractionAt(i, seed) * 60)) / 100;
            const length = (fraction * room * 100) / segments.length;
            const origin = baseline * 100 + (towardStart ? -stack : stack);
            const start = towardStart ? origin - length : origin;
            stack += length;
            return (
              <rect
                key={`${i}-${col}-${j}`}
                rx={stacked && j < segments.length - 1 ? 0 : 2}
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

/** Muted statistical silhouette as in shadcn.io/examples/histogram-loading.
 * Heights are illustrative and remain still while the light moves across it. */
export function LoadingHistogram({
  count,
  groups,
  stacked,
  width,
  height,
}: {
  count: number;
  groups: number;
  stacked: boolean;
  width?: number | string;
  height?: number | string;
}) {
  const w = typeof width === "number" ? width : 600,
    h = typeof height === "number" ? height : 220;
  const n = Math.max(1, count),
    step = w / n,
    gap = Math.min(2, step * 0.12);
  const bins = Array.from({ length: n }, (_, i) =>
    Array.from({ length: groups }, (_, j) => {
      const t = (i + 0.5) / n,
        center = 0.35 + 0.09 * j;
      return (
        0.08 +
        0.72 *
          Math.exp(-0.5 * ((t - center) / 0.195) ** 2) *
          (0.86 + 0.14 * fractionAt(i, j)) +
        0.16 * Math.exp(-0.5 * ((t - center - 0.21) / 0.28) ** 2)
      );
    }),
  );
  const max = Math.max(
    ...bins.map((values) =>
      stacked ? values.reduce((a, b) => a + b, 0) : Math.max(...values),
    ),
  );
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
    >
      <g
        className="chart-skeleton-histogram"
        data-skeleton-mark="histogram"
        fill="var(--bk-muted, var(--board-muted, #9299a4))"
      >
        {bins.map((values, i) => {
          let base = h;
          return values.map((v, j) => {
            const barH = (0.82 * h * v) / max;
            const y = (stacked ? base : h) - barH;
            if (stacked) base = y;
            return (
              <path
                key={`${i}:${j}`}
                data-skeleton-bin={i}
                fillOpacity={
                  groups === 1
                    ? 0.78
                    : stacked
                      ? 0.48 + (0.4 * j) / (groups - 1)
                      : 0.45
                }
                d={binPath(
                  i * step + gap / 2,
                  y,
                  step - gap,
                  barH,
                  !stacked || j === groups - 1,
                )}
              />
            );
          });
        })}
      </g>
    </svg>
  );
}
