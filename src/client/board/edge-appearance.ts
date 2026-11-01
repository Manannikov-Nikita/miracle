import {
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";
import type { BoardEdge, BoardEdgeAppearance } from "../../shared/types";
import type { EdgeGeometry, EdgePoint } from "./edge-geometry";

export const edgeColors = [
  {
    label: "По умолчанию",
    value: undefined,
    color: "var(--board-muted, var(--muted))",
  },
  { label: "Зелёный", value: "#a4c3b2", color: "#a4c3b2" },
  { label: "Синий", value: "#91b5ff", color: "#91b5ff" },
  { label: "Жёлтый", value: "#e6c28d", color: "#e6c28d" },
  { label: "Красный", value: "#e6a0a5", color: "#e6a0a5" },
  { label: "Фиолетовый", value: "#c5a4eb", color: "#c5a4eb" },
];

export function edgeAppearance(value: BoardEdgeAppearance = {}) {
  const width = value.width ?? 1.5;
  return {
    path: value.path ?? "smoothstep",
    line: value.line ?? "solid",
    color: value.color ?? "var(--board-muted)",
    width,
    startArrow: value.startArrow ?? false,
    endArrow: value.endArrow ?? true,
    dash:
      value.line === "dashed"
        ? `${width * 4} ${width * 3}`
        : value.line === "dotted"
          ? `1 ${width * 3}`
          : undefined,
  };
}

export function edgeGeometry(
  props: Pick<
    EdgeProps,
    | "sourceX"
    | "sourceY"
    | "targetX"
    | "targetY"
    | "sourcePosition"
    | "targetPosition"
  >,
  appearance?: BoardEdgeAppearance,
  bend?: BoardEdge["bend"],
) {
  if (bend && appearance?.path !== "straight") {
    const point = {
      x: (props.sourceX + props.targetX) / 2 + bend.x,
      y: (props.sourceY + props.targetY) / 2 + bend.y,
    };
    if (appearance?.path === "bezier") {
      const base = getBezierPath(props);
      const n = numbers(base[0]);
      const dx = ((point.x - base[1]) * 4) / 3;
      const dy = ((point.y - base[2]) * 4) / 3;
      if (!dx && !dy) return base;
      return [
        `M${n[0]},${n[1]} C${n[2] + dx},${n[3] + dy} ${n[4] + dx},${n[5] + dy} ${n[6]},${n[7]}`,
        point.x,
        point.y,
        Math.abs(point.x - props.sourceX),
        Math.abs(point.y - props.sourceY),
      ] as const;
    }
    const base = getSmoothStepPath(props);
    const route = angularRoute(props);
    const delta = { x: point.x - route.anchor.x, y: point.y - route.anchor.y };
    if (!delta.x && !delta.y) return base;
    const start = route.points[route.segment];
    const end = route.points[route.segment + 1];
    const a = {
      x: start.x * 0.75 + end.x * 0.25 + delta.x,
      y: start.y * 0.75 + end.y * 0.25 + delta.y,
    };
    const b = {
      x: start.x * 0.25 + end.x * 0.75 + delta.x,
      y: start.y * 0.25 + end.y * 0.75 + delta.y,
    };
    const horizontal = start.y === end.y;
    const points = simplifyPoints([
      ...route.points.slice(0, route.segment + 1),
      ...orthogonalConnector(start, a, horizontal),
      b,
      ...orthogonalConnector(b, end, horizontal),
      ...route.points.slice(route.segment + 2),
    ]);
    return [
      roundedPath(points),
      point.x,
      point.y,
      Math.abs(point.x - props.sourceX),
      Math.abs(point.y - props.sourceY),
    ] as const;
  }
  switch (appearance?.path) {
    case "straight":
      return getStraightPath(props);
    case "bezier":
      return getBezierPath(props);
    default:
      return getSmoothStepPath(props);
  }
}

const numbers = (path: string) =>
  path.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
const distance = (a: EdgePoint, b: EdgePoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

function simplifyPoints(input: EdgePoint[]) {
  const points: EdgePoint[] = [];
  for (const point of input) {
    const last = points[points.length - 1];
    if (last?.x === point.x && last.y === point.y) continue;
    while (points.length > 1) {
      const a = points[points.length - 2];
      const b = points[points.length - 1];
      const horizontal =
        a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0;
      const vertical =
        a.x === b.x && b.x === point.x && (b.y - a.y) * (point.y - b.y) >= 0;
      if (!horizontal && !vertical) break;
      points.pop();
    }
    points.push(point);
  }
  return points;
}

function angularRoute(geometry: EdgeGeometry) {
  const coordinates = numbers(
    getSmoothStepPath({ ...geometry, borderRadius: 0 })[0],
  );
  const points = simplifyPoints(
    Array.from({ length: coordinates.length / 2 }, (_, index) => ({
      x: coordinates[index * 2],
      y: coordinates[index * 2 + 1],
    })),
  );
  let segment = 0;
  for (let index = 1; index < points.length - 1; index++) {
    if (
      distance(points[index], points[index + 1]) >
      distance(points[segment], points[segment + 1])
    )
      segment = index;
  }
  const a = points[segment];
  const b = points[segment + 1];
  return {
    points,
    segment,
    anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

function orthogonalConnector(
  a: EdgePoint,
  b: EdgePoint,
  horizontal: boolean,
): EdgePoint[] {
  return horizontal
    ? [{ x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, b]
    : [{ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }, b];
}

function roundedPath(points: EdgePoint[]) {
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1],
      b = points[index],
      c = points[index + 1];
    const before = distance(a, b),
      after = distance(b, c);
    const radius = Math.min(5, before / 2, after / 2);
    if (
      !radius ||
      (a.x === b.x && b.x === c.x) ||
      (a.y === b.y && b.y === c.y)
    ) {
      path += `L${b.x},${b.y}`;
      continue;
    }
    path += `L${b.x + ((a.x - b.x) / before) * radius},${b.y + ((a.y - b.y) / before) * radius}Q${b.x},${b.y} ${b.x + ((c.x - b.x) / after) * radius},${b.y + ((c.y - b.y) / after) * radius}`;
  }
  const end = points[points.length - 1];
  return `${path}L${end.x},${end.y}`;
}

export function edgeBendPoint(
  geometry: EdgeGeometry,
  appearance?: BoardEdgeAppearance,
  bend?: BoardEdge["bend"],
): EdgePoint {
  const midpoint = {
    x: (geometry.sourceX + geometry.targetX) / 2,
    y: (geometry.sourceY + geometry.targetY) / 2,
  };
  if (appearance?.path === "straight") return midpoint;
  if (bend) return { x: midpoint.x + bend.x, y: midpoint.y + bend.y };
  if (appearance?.path === "bezier") {
    const base = getBezierPath(geometry);
    return { x: base[1], y: base[2] };
  }
  return angularRoute(geometry).anchor;
}
