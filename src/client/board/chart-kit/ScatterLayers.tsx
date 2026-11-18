import { memo, type CSSProperties } from "react";
import type { ChartPlotProps } from "./plot-types";
import { formatChartNumber } from "../chart-number";
import { truncateTick } from "./cartesian-geometry";
import {
  scatterRadius,
  scatterTick,
  type ScatterDatum,
  type scatterGeometry,
} from "./scatter-geometry";

type Geometry = ReturnType<typeof scatterGeometry>;

export const ScatterAxes = memo(function ScatterAxes({
  g,
  spec,
  xName,
  yName,
  width,
  height,
}: {
  g: Geometry;
  spec: ChartPlotProps["spec"];
  xName: string;
  yName: string;
  width: number;
  height: number;
}) {
  const kind = spec.numberFormat;
  return (
    <>
      {" "}
      {g.xAxis.ticks.map((t) => {
        const x = g.xAxis.at(t);
        const full = scatterTick(t, kind);
        const text = truncateTick(
          full,
          Math.min(
            82,
            (g.right - g.left) / Math.max(1, g.xAxis.ticks.length - 1),
          ),
        );
        return (
          <g key={t}>
            {spec.showGrid !== false && (
              <line
                className="bk-grid bk-scatter-grid-x"
                x1={x}
                x2={x}
                y1={g.top}
                y2={g.bottom}
              />
            )}
            {g.showX && (
              <text
                className="bk-scatter-tick-x"
                x={Math.max(
                  text.length * 3.3 + 1,
                  Math.min(width - text.length * 3.3 - 1, x),
                )}
                y={g.bottom + 14}
                textAnchor="middle"
              >
                {text}
                {text !== full && <title>{full}</title>}
              </text>
            )}
          </g>
        );
      })}
      {g.yAxis.ticks.map((t) => {
        const y = g.yAxis.at(t);
        const full = scatterTick(t, kind);
        const text = truncateTick(full, g.left - 18);
        return (
          <g key={t}>
            {spec.showGrid !== false && (
              <line
                className="bk-grid bk-scatter-grid-y"
                x1={g.left}
                x2={g.right}
                y1={y}
                y2={y}
              />
            )}
            {g.showY && (
              <text
                className="bk-scatter-tick-y"
                x={g.left - 6}
                y={y + 3}
                textAnchor="end"
              >
                {text}
                {text !== full && <title>{full}</title>}
              </text>
            )}
          </g>
        );
      })}
      {g.showX && height >= 100 && (
        <text
          className="bk-axis-name"
          x={(g.left + g.right) / 2}
          y={height - 3}
          textAnchor="middle"
        >
          {truncateTick(xName, g.right - g.left)}
        </text>
      )}
      {g.showY && width >= 210 && (
        <text
          className="bk-axis-name"
          transform={`translate(10 ${(g.top + g.bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {truncateTick(yName, g.bottom - g.top)}
        </text>
      )}
    </>
  );
});

export const ScatterCloud = memo(function ScatterCloud({
  g,
  spec,
  series,
  width,
}: {
  g: Geometry;
  spec: ChartPlotProps["spec"];
  series: ChartPlotProps["series"];
  width: number;
}) {
  // Claim screen-space tiles so dense clouds keep readable labels. Every point
  // remains keyboard accessible, including those with suppressed text.
  const occupied = new Set<string>();
  const label = (p: ScatterDatum) => {
    const raw =
      series[p.series].displayData?.[p.index]?.value ??
      formatChartNumber(p.y, spec.numberFormat);
    const text = truncateTick(raw, Math.min(120, (g.right - g.left) / 2));
    const half = text.length * 3.6 + 2;
    const x = Math.max(half, Math.min(width - half, p.cx)),
      y = p.cy - scatterRadius - 4;
    const tiles: string[] = [];
    for (
      let j = Math.floor((x - half) / 14);
      j <= Math.floor((x + half) / 14);
      j++
    ) {
      for (
        let k = Math.floor((y - 10) / 14);
        k <= Math.floor((y + 2) / 14);
        k++
      ) {
        const key = `${j},${k}`;
        if (occupied.has(key)) return null;
        tiles.push(key);
      }
    }
    tiles.forEach((key) => occupied.add(key));
    return (
      <text
        key={p.key}
        className="bk-value bk-scatter-label"
        x={x}
        y={y}
        textAnchor="middle"
      >
        {text}
        {text !== raw && <title>{raw}</title>}
      </text>
    );
  };
  // As in Bklit's series-markers.tsx, the left edge appears first. Share at most
  // 12 animation clocks while retaining a single SVG circle per observation.
  return g.bands.map(
    (band, i) =>
      band.length > 0 && (
        <g
          key={i}
          className="bk-scatter-enter"
          style={
            {
              "--scatter-delay": `${(1100 * i) / g.bands.length}ms`,
            } as CSSProperties
          }
        >
          {band.map((p) => (
            <circle
              className="bk-scatter-point"
              key={p.key}
              cx={p.cx}
              cy={p.cy}
              r={scatterRadius}
              fill={p.color}
            />
          ))}
          {spec.showLabels && band.map(label)}
        </g>
      ),
  );
});
