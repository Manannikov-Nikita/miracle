import type { ResizeSides } from "./resize-snapping";

export type ResizeRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Constrain a corner against the original opposite anchor, never a snapped frame. */
export function preserveResizeAspect(
  raw: ResizeRectangle,
  start: ResizeRectangle,
  sides: ResizeSides,
): ResizeRectangle {
  const corner =
    Boolean(sides.left) !== Boolean(sides.right) &&
    Boolean(sides.top) !== Boolean(sides.bottom);
  if (
    !corner ||
    ![
      start.x,
      start.y,
      start.width,
      start.height,
      raw.x,
      raw.y,
      raw.width,
      raw.height,
    ].every(Number.isFinite) ||
    start.width <= 0 ||
    start.height <= 0
  )
    return raw;

  const minScale = Math.max(280 / start.width, 180 / start.height);
  const maxScale = Math.min(10000 / start.width, 10000 / start.height);
  // Imported extreme ratios can make the minimum and maximum incompatible.
  // Keep their valid starting geometry instead of distorting or oversizing it.
  if (minScale > maxScale) return { ...start };
  // Match corner resizing: the larger relative extent drives the other axis.
  const scale = Math.min(
    maxScale,
    Math.max(minScale, raw.width / start.width, raw.height / start.height),
  );
  // Multiplication can overshoot a bound by one ULP (e.g. 10000.000000000002).
  const width = Math.min(10000, Math.max(280, start.width * scale));
  const height = Math.min(10000, Math.max(180, start.height * scale));
  return {
    x: sides.left ? start.x + start.width - width : start.x,
    y: sides.top ? start.y + start.height - height : start.y,
    width,
    height,
  };
}
