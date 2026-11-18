import { useId, useState, type SVGAttributes } from "react";

// Bar silhouette and sin² shimmer adapted from Bklit UI loading-sweep.tsx
// (MIT, bklit/bklit-ui@76299da). CSS animates the mask between passes.
const stops = Array.from({ length: 17 }, (_, index) => {
  const fraction = index / 16;
  return {
    offset: fraction,
    opacity: 0.05 + 0.85 * Math.sin(fraction * Math.PI) ** 2,
  };
});

type BarsProps = {
  count?: number;
  color?: string;
  horizontal?: boolean;
  baseline?: number;
};

export function SkeletonBars({
  count = 8,
  color = "#91c6ff",
  horizontal = false,
  baseline = horizontal ? 0 : 1,
  ...viewport
}: BarsProps &
  Pick<SVGAttributes<SVGSVGElement>, "x" | "y" | "width" | "height">) {
  const id = useId();
  const [pass, setPass] = useState(0);
  const slots = Math.max(1, Math.min(count, 64));
  const slot = 100 / slots;
  return (
    <svg
      {...viewport}
      className="chart-skeleton"
      aria-hidden="true"
      focusable="false"
    >
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
      <g
        className="chart-skeleton-bars"
        fill={color}
        fillOpacity=".45"
        mask={`url(#${id})`}
      >
        {Array.from({ length: slots }, (_, i) => {
          const hash = Math.sin((i + 1) * 12.9898 + pass) * 43758.5453;
          const fraction =
            (20 + Math.floor((hash - Math.floor(hash)) * 60)) / 100;
          const towardStart = baseline === 1 || (baseline > 0 && i % 2 === 0);
          const length = fraction * (towardStart ? baseline : 1 - baseline);
          const start = (towardStart ? baseline - length : baseline) * 100;
          const cross = (i + 0.15) * slot;
          return (
            <rect
              key={i}
              rx="2"
              x={`${horizontal ? start : cross}%`}
              y={`${horizontal ? cross : start}%`}
              width={`${horizontal ? length * 100 : slot * 0.7}%`}
              height={`${horizontal ? slot * 0.7 : length * 100}%`}
            />
          );
        })}
      </g>
    </svg>
  );
}

export default function ChartSkeleton(props: BarsProps) {
  return (
    <div className="chart-skeleton-frame" aria-hidden="true">
      <svg className="chart-skeleton-grid" width="100%" height="100%">
        {[0, 25, 50, 75, 100].map((offset) => (
          <line
            key={offset}
            x1={props.horizontal ? `${offset}%` : 0}
            x2={props.horizontal ? `${offset}%` : "100%"}
            y1={props.horizontal ? 0 : `${offset}%`}
            y2={props.horizontal ? "100%" : `${offset}%`}
          />
        ))}
      </svg>
      <SkeletonBars {...props} width="100%" height="100%" />
    </div>
  );
}
