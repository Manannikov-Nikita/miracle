import { preserveResizeAspect, type ResizeRectangle } from "./resize-aspect";
import type { ResizeSides } from "./resize-snapping";

type Point = { x: number; y: number };

export function normalizeRotation(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const remainder = angle % 360;
  return remainder === 0 ? 0 : remainder < 0 ? remainder + 360 : remainder;
}

export function snapRotation(angle: number, shift = false): number {
  const normalized = normalizeRotation(angle);
  return shift
    ? normalizeRotation(Math.round(normalized / 15) * 15)
    : normalized;
}

/** Clockwise degrees with the rotation handle's resting position (above) at zero. */
export function pointerRotation(center: Point, pointer: Point): number {
  if (center.x === pointer.x && center.y === pointer.y) return 0;
  return normalizeRotation(
    (Math.atan2(pointer.x - center.x, center.y - pointer.y) * 180) / Math.PI,
  );
}

export function rotatePoint(point: Point, center: Point, angle: number): Point {
  const radians = (normalizeRotation(angle) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

/**
 * Resize in the shape's local axes. Delta is measured in board coordinates
 * (the caller removes zoom), while x/y remain the unrotated layout box.
 * Moving the center by half the resized local extent keeps the opposite
 * corner/edge fixed in world coordinates, even when dimensions are clamped.
 */
export function rotatedResize(
  start: ResizeRectangle,
  angle: number,
  sides: ResizeSides,
  delta: Point,
  minimum = 40,
  keepAspect = false,
): ResizeRectangle {
  if (
    ![
      start.x,
      start.y,
      start.width,
      start.height,
      angle,
      delta.x,
      delta.y,
      minimum,
    ].every(Number.isFinite) ||
    start.width <= 0 ||
    start.height <= 0 ||
    minimum <= 0 ||
    minimum > 10000
  )
    return { ...start };
  const horizontal = Boolean(sides.left) !== Boolean(sides.right);
  const vertical = Boolean(sides.top) !== Boolean(sides.bottom);
  if (!horizontal && !vertical) return { ...start };
  const xSign = horizontal ? (sides.right ? 1 : -1) : 0;
  const ySign = vertical ? (sides.bottom ? 1 : -1) : 0;
  const localDelta = rotatePoint(delta, { x: 0, y: 0 }, -angle);
  const clamp = (value: number) => Math.min(10000, Math.max(minimum, value));
  let width = horizontal
    ? clamp(start.width + xSign * localDelta.x)
    : start.width;
  let height = vertical
    ? clamp(start.height + ySign * localDelta.y)
    : start.height;
  if (keepAspect && horizontal && vertical) {
    const constrained = preserveResizeAspect(
      { ...start, width, height },
      start,
      sides,
      { width: minimum, height: minimum },
    );
    width = constrained.width;
    height = constrained.height;
  }
  const centerShift = rotatePoint(
    {
      x: (xSign * (width - start.width)) / 2,
      y: (ySign * (height - start.height)) / 2,
    },
    { x: 0, y: 0 },
    angle,
  );
  return {
    x: start.x + start.width / 2 + centerShift.x - width / 2,
    y: start.y + start.height / 2 + centerShift.y - height / 2,
    width,
    height,
  };
}
