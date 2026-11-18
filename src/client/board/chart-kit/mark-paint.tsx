import { useId, useMemo } from "react";
import type { ChartMarkStyle } from "../../../shared/types";
import type { ChartSeriesItem } from "../model";
import { presentationColors } from "../presentation-colors";

type Pattern = Exclude<ChartMarkStyle["pattern"], "none" | undefined>;
type Style = ChartMarkStyle | undefined;

function dash(style: Style) {
  if (style?.borderStyle === "dashed") return "5 3";
  if (style?.borderStyle === "dotted") return "1 3";
  return undefined;
}

/** SVG paint servers belong to this plot, including when a board and a slide
 * preview render the same series simultaneously. One tile per pattern and ink. */
export function useChartPaint(
  series: readonly ChartSeriesItem[],
  colors: readonly string[],
) {
  const prefix = useId();
  return useMemo(() => {
    const patterns = new Map<string, { pattern: Pattern; color: string }>();
    const id = (pattern: Pattern, ink: string) =>
      `${prefix}-${pattern}-${ink.slice(1)}`;
    const collect = (style: Style, base: string) => {
      const pattern = style?.pattern;
      if (!pattern || pattern === "none") return;
      const color = style.color ?? base;
      patterns.set(id(pattern, color), { pattern, color });
    };
    series.forEach((item, s) => {
      collect(item.seriesStyle, colors[s]);
      if (
        !item.pointStyles &&
        (!item.displayData || !item.seriesStyle?.pattern)
      )
        return;
      item.data.forEach((_, i) =>
        collect(
          item.pointStyles?.[i] ?? item.seriesStyle,
          item.displayData?.[i]?.color ?? colors[s],
        ),
      );
    });
    const defs = patterns.size ? (
      <defs>
        {Array.from(patterns, ([key, { pattern, color }]) => {
          const ink = presentationColors(color).text;
          return (
            <pattern
              key={key}
              id={key}
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
            >
              <rect width="6" height="6" fill={color} />
              {pattern === "dots" ? (
                <circle cx="3" cy="3" r="1.15" fill={ink} fillOpacity=".7" />
              ) : (
                <path
                  d={
                    pattern === "crosshatch"
                      ? "M-1 1L1 -1M0 6L6 0M5 7L7 5M-1 5L1 7M0 0L6 6M5 -1L7 1"
                      : "M-1 1L1 -1M0 6L6 0M5 7L7 5"
                  }
                  fill="none"
                  stroke={ink}
                  strokeOpacity=".62"
                  strokeWidth="1.15"
                />
              )}
            </pattern>
          );
        })}
      </defs>
    ) : null;
    const ink = (style: Style, base: string) => {
      const color = style?.color ?? base;
      return style?.pattern && style.pattern !== "none"
        ? `url(#${id(style.pattern, color)})`
        : color;
    };
    function fill(style: Style, base: string) {
      const border =
        style &&
        (style.borderColor !== undefined ||
          style.borderWidth !== undefined ||
          style.borderStyle !== undefined);
      return {
        fill: ink(style, base),
        ...(style?.opacity !== undefined && {
          fillOpacity: style.opacity,
          strokeOpacity: style.opacity,
        }),
        ...(border && {
          stroke: style.borderColor ?? style.color ?? base,
          strokeWidth: style.borderWidth ?? 1.5,
          strokeDasharray: dash(style),
          strokeLinejoin: "round" as const,
        }),
      };
    }
    function line(style: Style, base: string, width = 2.4) {
      return {
        stroke: ink(style, base),
        strokeWidth: width,
        ...(style?.opacity !== undefined && { strokeOpacity: style.opacity }),
        ...(style?.borderStyle && { strokeDasharray: dash(style) }),
      };
    }
    function outline(style: Style, base: string, width = 2.4) {
      if (
        !style ||
        style.borderWidth === 0 ||
        (style.borderWidth === undefined && !style.borderColor)
      )
        return undefined;
      return {
        stroke: style.borderColor ?? style.color ?? base,
        strokeWidth: width + 2 * (style.borderWidth ?? 1.5),
        strokeOpacity: style.opacity,
        strokeDasharray: dash(style),
      };
    }
    return { defs, fill, line, outline };
  }, [series, colors, prefix]);
}
