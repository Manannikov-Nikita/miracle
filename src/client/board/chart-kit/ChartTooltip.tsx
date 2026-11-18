import { useCallback, useLayoutEffect, useRef, useState } from "react";
import "./tooltip.css";

type TooltipRow = {
  key: string;
  name: string;
  value: string;
  color: string;
  active?: boolean;
};

type Props = {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  rows: TooltipRow[];
};

/** Position in the plot's CSS pixels. Board zoom and page scroll transform the plot and its card together. */
function place(
  anchor: number,
  size: number,
  limit: number,
  inset: number,
  preferForward: boolean,
) {
  const gap = 12;
  const forward = anchor + gap;
  const backward = anchor - gap - size;
  const max = Math.max(inset, limit - inset - size);
  const fitsForward = forward <= max;
  const fitsBackward = backward >= inset;
  let useForward = preferForward;
  if (fitsForward !== fitsBackward) useForward = fitsForward;
  else if (!fitsForward) useForward = limit - anchor >= anchor;
  return Math.min(max, Math.max(inset, useForward ? forward : backward));
}

export default function ChartTooltip({
  id,
  x,
  y,
  width,
  height,
  title,
  rows,
}: Props) {
  const card = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 0, height: 0, capacity: 1 });
  const inset = Math.max(0, Math.min(4, width / 12, height / 12));
  const maxWidth = Math.max(0, width - 2 * inset);
  const maxHeight = Math.max(0, height - 2 * inset);
  const compact = maxHeight < 49;

  const measure = useCallback(() => {
    const el = card.current;
    const body = list.current;
    if (!el || !body) return;
    const rowHeight =
      (body.firstElementChild instanceof HTMLElement &&
        body.firstElementChild.offsetHeight) ||
      20;
    const bottom =
      (parseFloat(getComputedStyle(el).paddingBottom) || 0) +
      el.offsetHeight -
      el.clientHeight;
    const capacity = !compact
      ? Math.max(
          1,
          Math.floor((maxHeight - body.offsetTop - bottom) / rowHeight),
        )
      : 1;
    const next = { width: el.offsetWidth, height: el.offsetHeight, capacity };
    setLayout((prev) =>
      prev.width === next.width &&
      prev.height === next.height &&
      prev.capacity === capacity
        ? prev
        : next,
    );
  }, [maxHeight, compact]);

  useLayoutEffect(measure, [measure, maxWidth, title, rows, layout.capacity]);
  useLayoutEffect(() => {
    if (!card.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [measure]);

  let visible = rows;
  if (rows.length > layout.capacity) {
    // Keep selected observations in view even when a category contains many series.
    const active = rows.filter((row) => row.active);
    let remaining = layout.capacity - active.length;
    visible =
      remaining > 0
        ? rows.filter((row) => row.active || remaining-- > 0)
        : active.slice(0, layout.capacity);
  }
  const omitted = rows.length - visible.length;
  return (
    <div
      ref={card}
      id={id}
      className="chart-tooltip"
      role="tooltip"
      aria-live="polite"
      aria-atomic="true"
      data-compact={compact || undefined}
      style={{
        maxWidth,
        maxHeight,
        left: place(x, layout.width, width, inset, true),
        top: place(y, layout.height, height, inset, false),
      }}
    >
      <div className="chart-tooltip-heading">
        <strong>{title}</strong>
        {omitted > 0 && (
          <span
            className="chart-tooltip-more"
            aria-label={`Скрыто рядов: ${omitted}`}
          >
            +{omitted}
          </span>
        )}
      </div>
      <div ref={list} className="chart-tooltip-rows">
        {visible.map((row) => (
          <div
            className="chart-tooltip-row"
            key={row.key}
            data-active={(row.active && rows.length > 1) || undefined}
          >
            <span
              className="chart-tooltip-swatch"
              aria-hidden="true"
              style={{ backgroundColor: row.color }}
            />
            <span className="chart-tooltip-name">{row.name}</span>
            <span className="chart-tooltip-value">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
