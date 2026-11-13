import {
  resolveShape,
  type ShapeKind,
  type ShapeSpec,
} from "../../shared/shapes";
import type { BoardNode } from "../../shared/types";
import { rotatePoint } from "./shape-rotation";

export type Point = { x: number; y: number };
export type VisualBounds = {
  x: number;
  y: number;
  right: number;
  bottom: number;
};

export const SHAPE_POLYGON_POINTS: Partial<
  Record<ShapeKind, readonly Point[]>
> = {
  triangle: [
    { x: 50, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ],
  diamond: [
    { x: 50, y: 0 },
    { x: 100, y: 50 },
    { x: 50, y: 100 },
    { x: 0, y: 50 },
  ],
  hexagon: [
    { x: 25, y: 0 },
    { x: 75, y: 0 },
    { x: 100, y: 50 },
    { x: 75, y: 100 },
    { x: 25, y: 100 },
    { x: 0, y: 50 },
  ],
  arrow: [
    { x: 0, y: 30 },
    { x: 62, y: 30 },
    { x: 62, y: 0 },
    { x: 100, y: 50 },
    { x: 62, y: 100 },
    { x: 62, y: 70 },
    { x: 0, y: 70 },
  ],
};

function positive(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function pointBounds(points: readonly Point[], radius = 0): VisualBounds {
  return {
    x: Math.min(...points.map((point) => point.x)) - radius,
    y: Math.min(...points.map((point) => point.y)) - radius,
    right: Math.max(...points.map((point) => point.x)) + radius,
    bottom: Math.max(...points.map((point) => point.y)) + radius,
  };
}

function unionBounds(boxes: readonly VisualBounds[]): VisualBounds {
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function shaftBounds(
  start: Point,
  end: Point,
  width: number,
  style: NonNullable<ShapeSpec["strokeStyle"]>,
  transform: (point: Point) => Point = (point) => point,
) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  let paintedLength = length;
  if (width > 0 && length > 0 && style !== "solid") {
    const period = width * (style === "dotted" ? 2.5 : 6);
    const ratio = length / period;
    // SVG starts a subsequent dash only before the path end. Remove arithmetic
    // noise around exact pattern boundaries (especially for diagonal lengths).
    if (Number.isFinite(ratio)) {
      const nearest = Math.round(ratio);
      const cycles =
        Math.abs(ratio - nearest) <= Number.EPSILON * Math.max(1, ratio) * 8
          ? nearest
          : ratio;
      const lastStart = Math.max(0, Math.ceil(cycles) - 1) * period;
      paintedLength =
        style === "dotted"
          ? lastStart
          : Math.min(length, lastStart + width * 4);
    }
  }
  const paintedEnd =
    length > 0
      ? {
          x: start.x + (end.x - start.x) * (paintedLength / length),
          y: start.y + (end.y - start.y) * (paintedLength / length),
        }
      : start;
  // The first and last painted intervals give all extrema of a straight shaft;
  // intermediate collinear dashes/dots cannot enlarge its axis-aligned bounds.
  // Resolve the pattern in local coordinates before rotation, keeping its phase
  // independent of the floating-point length of transformed endpoints.
  start = transform(start);
  end = transform(paintedEnd);
  const radius = width / 2;
  if (style === "dotted") return pointBounds([start, end], radius);
  const paintedDistance = Math.hypot(end.x - start.x, end.y - start.y);
  if (!paintedDistance) return pointBounds([start]);
  const x = ((end.y - start.y) / paintedDistance) * radius;
  const y = ((end.x - start.x) / paintedDistance) * radius;
  return pointBounds([
    { x: start.x + x, y: start.y - y },
    { x: start.x - x, y: start.y + y },
    { x: end.x + x, y: end.y - y },
    { x: end.x - x, y: end.y + y },
  ]);
}

function arrowPoints(tip: Point, toward: Point, length: number): Point[] {
  const distance = Math.hypot(toward.x - tip.x, toward.y - tip.y);
  const dx = (toward.x - tip.x) / (distance || 1);
  const dy = (toward.y - tip.y) / (distance || 1);
  const halfWidth = length * 0.45;
  const base = { x: tip.x + dx * length, y: tip.y + dy * length };
  return [
    tip,
    { x: base.x - dy * halfWidth, y: base.y + dx * halfWidth },
    { x: base.x + dy * halfWidth, y: base.y - dx * halfWidth },
  ];
}

export type LineGeometry = {
  start: Point;
  end: Point;
  shaftStart: Point;
  shaftEnd: Point;
  startHead?: Point[];
  endHead?: Point[];
  bounds: VisualBounds;
};

/** The existing line layout, in unzoomed local pixels. Never rewrites saved frames. */
export function getLineGeometry(
  shape: ShapeSpec | undefined,
  width: number,
  height: number,
): LineGeometry {
  const spec = resolveShape(shape);
  width = positive(width, 260);
  height = positive(height, 40);
  const startArrow = spec.lineStart === "arrow" && spec.strokeWidth > 0;
  const endArrow = spec.lineEnd === "arrow" && spec.strokeWidth > 0;
  const desiredHead = Math.min(
    Math.max(8, spec.strokeWidth * 4),
    Math.min(width, height) * 0.35,
  );
  const padding = Math.min(
    spec.strokeWidth / 2 +
      1 +
      (startArrow || endArrow ? desiredHead * 0.45 : 0),
    width / 3,
    height / 3,
  );
  let start: Point;
  let end: Point;
  if (spec.lineDirection === "vertical") {
    start = { x: width / 2, y: padding };
    end = { x: width / 2, y: height - padding };
  } else if (spec.lineDirection === "diagonal-down") {
    start = { x: padding, y: padding };
    end = { x: width - padding, y: height - padding };
  } else if (spec.lineDirection === "diagonal-up") {
    start = { x: padding, y: height - padding };
    end = { x: width - padding, y: padding };
  } else {
    start = { x: padding, y: height / 2 };
    end = { x: width - padding, y: height / 2 };
  }
  const headLength = Math.min(
    desiredHead,
    Math.hypot(end.x - start.x, end.y - start.y) /
      (startArrow && endArrow ? 3 : 2),
  );
  const distance = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const dx = (end.x - start.x) / distance;
  const dy = (end.y - start.y) / distance;
  // Preserve pointed heads: the shaft ends at their bases, never at their tips.
  const shaftStart = startArrow
    ? { x: start.x + dx * headLength, y: start.y + dy * headLength }
    : start;
  const shaftEnd = endArrow
    ? { x: end.x - dx * headLength, y: end.y - dy * headLength }
    : end;
  const startHead = startArrow
    ? arrowPoints(start, end, headLength)
    : undefined;
  const endHead = endArrow ? arrowPoints(end, start, headLength) : undefined;
  return {
    start,
    end,
    shaftStart,
    shaftEnd,
    startHead,
    endHead,
    bounds: unionBounds([
      shaftBounds(shaftStart, shaftEnd, spec.strokeWidth, spec.strokeStyle),
      ...[startHead, endHead].flatMap((head) =>
        head ? [pointBounds(head)] : [],
      ),
    ]),
  };
}

/** Tight world bounds of painted geometry. Hit targets and control handles are excluded. */
export function getNodeVisualBounds(node: BoardNode): VisualBounds {
  const width = positive(node.width, 480);
  const height = positive(node.height, 300);
  const { x, y } = node.position;
  if (node.data.kind !== "shape")
    return { x, y, right: x + width, bottom: y + height };
  const spec = resolveShape(node.data.shape);
  const center = { x: x + width / 2, y: y + height / 2 };
  const transform = (point: Point) =>
    rotatePoint({ x: x + point.x, y: y + point.y }, center, spec.rotation);
  if (spec.type === "line") {
    const line = getLineGeometry(spec, width, height);
    return unionBounds([
      shaftBounds(
        line.shaftStart,
        line.shaftEnd,
        spec.strokeWidth,
        spec.strokeStyle,
        transform,
      ),
      ...[line.startHead, line.endHead].flatMap((head) =>
        head ? [pointBounds(head.map(transform))] : [],
      ),
    ]);
  }

  const radius = spec.strokeWidth / 2;
  const innerWidth = Math.max(0, width - spec.strokeWidth);
  const innerHeight = Math.max(0, height - spec.strokeWidth);
  const polygon = SHAPE_POLYGON_POINTS[spec.type];
  if (polygon)
    return pointBounds(
      polygon.map((point) =>
        transform({
          x: radius + (point.x * innerWidth) / 100,
          y: radius + (point.y * innerHeight) / 100,
        }),
      ),
      radius,
    );

  const radians = (spec.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const halfWidth = innerWidth / 2;
  const halfHeight = innerHeight / 2;
  // A rounded rectangle is an inner rectangle plus an elliptical corner;
  // its support function also gives an exact ellipse when the inner part is zero.
  const corner =
    spec.type === "ellipse" ? 0.5 : Math.min(50, spec.cornerRadius) / 100;
  const rx = innerWidth * corner;
  const ry = innerHeight * corner;
  const extentX =
    (halfWidth - rx) * Math.abs(cosine) +
    (halfHeight - ry) * Math.abs(sine) +
    Math.hypot(rx * cosine, ry * sine) +
    radius;
  const extentY =
    (halfWidth - rx) * Math.abs(sine) +
    (halfHeight - ry) * Math.abs(cosine) +
    Math.hypot(rx * sine, ry * cosine) +
    radius;
  return {
    x: center.x - extentX,
    y: center.y - extentY,
    right: center.x + extentX,
    bottom: center.y + extentY,
  };
}
