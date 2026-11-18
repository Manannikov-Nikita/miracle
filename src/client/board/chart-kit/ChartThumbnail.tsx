import { Fragment, memo, useMemo } from "react";
import type { ChartKind } from "../../../shared/types";
import type { ChartPlotProps } from "./plot-types";
import { thumbnailGeometry } from "./thumbnail-geometry";

const names: Record<ChartKind, string> = {
  bar: "Столбчатая диаграмма",
  line: "Линейный график",
  area: "График с областями",
  composed: "Комбинированный график",
  scatter: "Точечная диаграмма",
  histogram: "Гистограмма",
  heatmap: "Тепловая карта",
  sparkline: "Спарклайн",
};

export default memo(function ChartThumbnail({
  spec,
  series,
  colors,
  label,
}: ChartPlotProps) {
  const { paths, guides, baseline } = useMemo(
    () => thumbnailGeometry({ spec, series, colors }),
    [spec, series, colors],
  );
  return (
    <svg
      className="bk-chart-thumbnail"
      data-kind={spec.kind}
      viewBox="0 0 240 120"
      width="100%"
      height="100%"
      preserveAspectRatio="none"
      focusable="false"
      role="img"
      aria-label={`${label ? label + ". " : ""}${names[spec.kind]}. Количество рядов: ${series.length}.`}
      style={{ display: "block", pointerEvents: "none" }}
    >
      {guides && (
        <path
          d={guides}
          stroke="var(--bk-grid, var(--board-border, #59616b))"
          strokeWidth="0.6"
          opacity="0.64"
          fill="none"
        />
      )}
      {baseline && (
        <path
          d={baseline}
          stroke="var(--bk-muted, var(--board-muted, #939aa4))"
          strokeWidth="0.7"
          opacity="0.72"
          fill="none"
        />
      )}
      {paths.map(({ d, color, opacity, mark, border }, i) => {
        const stroke = mark === "line" || mark === "point";
        return (
          <Fragment key={i}>
            {border && stroke && (
              <path
                d={d}
                stroke={border}
                strokeWidth={mark === "point" ? 4.6 : 4}
                opacity={opacity}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            <path
              data-mark={mark}
              d={d}
              fill={stroke ? "none" : color}
              stroke={stroke ? color : border}
              strokeWidth={
                stroke ? (mark === "point" ? 3 : 2.5) : border ? 0.9 : undefined
              }
              strokeLinejoin={stroke ? "round" : undefined}
              strokeLinecap={stroke ? "round" : undefined}
              opacity={opacity === 1 ? undefined : opacity}
            />
          </Fragment>
        );
      })}
    </svg>
  );
});
