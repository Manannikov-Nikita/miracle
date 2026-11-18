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
  motion?: boolean;
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
  previousSide?: boolean,
) {
  const gap = 12;
  const forward = anchor + gap;
  const backward = anchor - gap - size;
  const max = Math.max(inset, limit - inset - size);
  const fitsForward = forward <= max;
  const fitsBackward = backward >= inset;
  let useForward = preferForward;
  if (fitsForward !== fitsBackward) useForward = fitsForward;
  else {
    // A small dead band keeps neighbouring values of slightly different widths
    // on the same side of the pointer when it hovers at the flip threshold.
    const hysteresis = 8;
    if (fitsForward) {
      const preferredSlack = preferForward ? max - forward : backward - inset;
      if (previousSide !== undefined && preferredSlack < hysteresis)
        useForward = previousSide;
    } else {
      const balance = limit - 2 * anchor;
      useForward =
        previousSide !== undefined && Math.abs(balance) < hysteresis
          ? previousSide
          : balance >= 0;
    }
  }
  return {
    forward: useForward,
    position: Math.min(max, Math.max(inset, useForward ? forward : backward)),
  };
}

export default function ChartTooltip({
  id,
  motion = true,
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
  const lastPlacement = useRef<{
    x: number;
    y: number;
    horizontalForward: boolean;
    verticalForward: boolean;
    following: boolean;
  } | null>(null);
  const measuredBounds = useRef<{
    inset: number;
    maxX: number;
    maxY: number;
  } | null>(null);
  const snapAt = useRef<{ x: number; y: number } | null>(null);
  const previous = lastPlacement.current;
  const horizontal = place(
    x,
    layout.width,
    width,
    inset,
    true,
    previous?.horizontalForward,
  );
  const vertical = place(
    y,
    layout.height,
    height,
    inset,
    false,
    previous?.verticalForward,
  );
  // Initial measurement may change both the size and the side before first paint.
  // Start following only after observing a second distinct anchor.
  const following = Boolean(
    previous && (previous.following || x !== previous.x || y !== previous.y),
  );
  const snapped = snapAt.current?.x === x && snapAt.current?.y === y;
  useLayoutEffect(() => {
    if (!snapped) snapAt.current = null;
    if (layout.width && layout.height) {
      lastPlacement.current = {
        x,
        y,
        horizontalForward: horizontal.forward,
        verticalForward: vertical.forward,
        following,
      };
    }
  }, [
    x,
    y,
    horizontal.forward,
    vertical.forward,
    following,
    snapped,
    layout.width,
    layout.height,
  ]);

  const measure = useCallback(() => {
    const el = card.current;
    const body = list.current;
    if (!el || !body) return;
    const rowHeight =
      (body.firstElementChild instanceof HTMLElement &&
        body.firstElementChild.offsetHeight) ||
      20;
    const computed = getComputedStyle(el);
    const cardHeight = el.offsetHeight;
    const cardWidth = el.offsetWidth;
    const bottom =
      (parseFloat(computed.paddingBottom) || 0) + cardHeight - el.clientHeight;
    const capacity = !compact
      ? Math.max(
          1,
          Math.floor((maxHeight - body.offsetTop - bottom) / rowHeight),
        )
      : 1;
    const next = { width: cardWidth, height: cardHeight, capacity };
    const maxX = Math.max(inset, width - inset - cardWidth);
    const maxY = Math.max(inset, height - inset - cardHeight);
    const bounds = measuredBounds.current;
    const placement = lastPlacement.current;
    let mustSnap = false;
    if (
      bounds &&
      placement?.following &&
      (inset > bounds.inset || maxX < bounds.maxX || maxY < bounds.maxY)
    ) {
      // A longer label can grow past an edge in the middle of a glide. Check
      // the actual interpolated translation before paint, only when space shrinks.
      const transform =
        typeof DOMMatrixReadOnly === "undefined"
          ? null
          : new DOMMatrixReadOnly(
              computed.transform === "none" ? undefined : computed.transform,
            );
      mustSnap =
        !transform ||
        transform.m41 < inset ||
        transform.m41 > maxX ||
        transform.m42 < inset ||
        transform.m42 > maxY;
      if (mustSnap) snapAt.current = { x: placement.x, y: placement.y };
    }
    measuredBounds.current = { inset, maxX, maxY };
    setLayout((prev) =>
      !mustSnap &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.capacity === capacity
        ? prev
        : next,
    );
  }, [maxHeight, compact, width, height, inset]);

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
      data-motion={(motion && following && !snapped) || undefined}
      style={{
        maxWidth,
        maxHeight,
        transform: `translate3d(${horizontal.position}px, ${vertical.position}px, 0)`,
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
