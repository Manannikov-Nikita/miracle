import { type CSSProperties, type ReactNode } from "react";
import type { ChartSpec } from "../../../shared/types";
import { formatChartNumber } from "../chart-number";
import { presentationColors } from "../presentation-colors";
import { truncateTick } from "./cartesian-geometry";
import { barRect, type Geometry, type Sample } from "./cartesian-focus";

/** A flat join at the base of the end segment. Only the exposed tip is rounded. */
function roundedTip(
  horizontal: boolean,
  start: number,
  width: number,
  base: number,
  end: number,
  radius: number,
) {
  const xy = (cross: number, value: number) =>
    horizontal ? `${value},${cross}` : `${cross},${value}`;
  const far = start + width;
  const shoulder = end + Math.sign(base - end) * radius;
  return `M${xy(start, base)} L${xy(start, shoulder)} Q${xy(start, end)} ${xy(start + radius, end)} L${xy(far - radius, end)} Q${xy(far, end)} ${xy(far, shoulder)} L${xy(far, base)} Z`;
}

type Anchor = "start" | "middle" | "end";
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Check nearby labels only, even with thousands of segments. The text in this
 * chart is 10px system-ui, with a little extra padding for bold totals. */
function stackLabelLayout() {
  const buckets = new Map<number, Box[]>();
  const context =
    typeof CanvasRenderingContext2D === "undefined"
      ? null
      : document.createElement("canvas").getContext("2d");
  return (text: string, x: number, y: number, anchor: Anchor, bold = false) => {
    if (context) context.font = `${bold ? 650 : 400} 10px system-ui`;
    const width = context?.measureText(text).width ?? text.length * 6.2;
    const left =
      x - (anchor === "end" ? width : anchor === "middle" ? width / 2 : 0);
    const box = {
      left: left - 1.5,
      right: left + width + 1.5,
      top: y - 6,
      bottom: y + 6,
    };
    const start = Math.floor(box.left / 32),
      end = Math.floor(box.right / 32);
    for (let k = start; k <= end; k++) {
      if (
        buckets
          .get(k)
          ?.some(
            (other) =>
              box.left < other.right &&
              box.right > other.left &&
              box.top < other.bottom &&
              box.bottom > other.top,
          )
      )
        return false;
    }
    for (let k = start; k <= end; k++) {
      const list = buckets.get(k);
      if (list) list.push(box);
      else buckets.set(k, [box]);
    }
    return true;
  };
}

export default function StackedBarMarks({
  g,
  spec,
  width,
  register,
}: {
  g: Geometry;
  spec: ChartSpec;
  width: number;
  register: (point: Sample["point"], node: SVGGraphicsElement | null) => void;
}) {
  // A whole column grows as one unit. Sparse series and newly unhidden segments
  // share their category's clock and transform around the same zero axis.
  const groups = g.categories.map((): ReactNode[] => []);
  const inside = spec.labelPosition !== "outside";
  const totalGroups = g.categories.map((): ReactNode[] => []);
  const reserve = stackLabelLayout();
  const offsets = [...new Set(g.marks.map((mark) => mark.offset))].sort(
    (a, b) => a - b,
  );
  const lane =
    offsets.length > 1
      ? Math.min(g.slot / offsets.length, offsets[1] - offsets[0])
      : g.slot;
  // At sub-label widths, sample legible figures rather than placing an ellipsis on every bar.
  const labelRoom = g.horizontal ? width * 0.14 : lane >= 18 ? lane - 3 : 48;
  const outside = spec.showLabels && !inside;
  for (const total of g.stackTotals) {
    const sign = total.value < 0 ? -1 : 1;
    const x = total.x + (g.horizontal ? sign * 5 : 0);
    const anchor: Anchor = g.horizontal
      ? sign < 0
        ? "end"
        : "start"
      : "middle";
    const full = formatChartNumber(total.value, spec.numberFormat);
    const text = truncateTick(full, labelRoom);
    const normal = g.horizontal ? total.y : total.y + (sign > 0 ? -7 : 9);
    const preferred = outside ? normal - 12 * sign : normal;
    // A narrow horizontal lane may put the shifted total on another stack.
    // Try its normal anchor before omitting a colliding total.
    const y = [preferred, normal].find((candidate) =>
      reserve(text, x, candidate, anchor, true),
    );
    if (y === undefined) continue;
    totalGroups[total.category].push(
      <text
        key={total.metricId}
        className="bk-stack-total"
        x={x}
        y={y}
        textAnchor={anchor}
        dominantBaseline="central"
      >
        {text}
        {text !== full && <title>{full}</title>}
      </text>,
    );
  }
  for (const mark of g.marks) {
    for (const p of mark.points) {
      if (p.value === null) continue;
      const { category, value, basePx, endPx } = p;
      const start = g.center(category) + mark.offset;
      const middle = start + g.barWidth / 2;
      const centerValue = (basePx + endPx) / 2;
      const length = Math.abs(endPx - basePx);
      const color = p.color ?? mark.color;
      const rect = barRect(g, start, endPx, basePx);
      const ref = (node: SVGGraphicsElement | null) => register(p, node);
      const tip = p.outer && length > 0 && rect.rx > 0;
      const direction = value < 0 ? -1 : 1;
      let label: ReactNode;
      if (spec.showLabels) {
        const text = p.display ?? formatChartNumber(value, spec.numberFormat);
        const room = inside
          ? (g.horizontal ? length : g.barWidth) - 4
          : labelRoom;
        const fits = inside
          ? length >= (g.horizontal ? 12 : 14) &&
            g.barWidth >= (g.horizontal ? 14 : 12) &&
            room >= 7
          : g.slot >= (g.horizontal ? 13 : 20);
        if (fits) {
          const caption = truncateTick(text, room);
          const anchor: Anchor =
            g.horizontal && !inside
              ? direction < 0
                ? "end"
                : "start"
              : "middle";
          const x = g.horizontal
            ? inside
              ? centerValue
              : endPx + direction * 4
            : middle;
          const y = g.horizontal
            ? middle
            : inside
              ? centerValue
              : endPx + (direction > 0 ? -6 : 9);
          if (reserve(caption, x, y, anchor))
            label = (
              <text
                className={
                  inside
                    ? "bk-inside bk-stack-value"
                    : "bk-value bk-stack-value"
                }
                x={x}
                y={y}
                textAnchor={anchor}
                dominantBaseline="central"
                style={
                  inside
                    ? { fill: presentationColors(color).text, stroke: "none" }
                    : undefined
                }
              >
                {caption}
                {caption !== text && <title>{text}</title>}
              </text>
            );
        }
      }
      groups[category].push(
        <g key={mark.key}>
          {tip ? (
            <path
              ref={ref}
              className="bk-bar"
              fill={color}
              d={roundedTip(
                g.horizontal,
                start,
                g.barWidth,
                basePx,
                endPx,
                rect.rx,
              )}
            />
          ) : (
            <rect ref={ref} className="bk-bar" {...rect} rx={0} fill={color} />
          )}
          {label}
        </g>,
      );
    }
  }
  return (
    <g data-series-style="bar" className="bk-stacks">
      {groups.map((children, category) => (
        <g
          key={category}
          className="bk-stack-category"
          style={
            {
              "--bk-delay": `${(category * 360) / groups.length}ms`,
              transformOrigin: g.horizontal ? `${g.zero}px 0` : `0 ${g.zero}px`,
            } as CSSProperties
          }
        >
          {children}
          {totalGroups[category]}
        </g>
      ))}
    </g>
  );
}
