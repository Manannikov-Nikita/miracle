import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import {
  edgeBendPoint,
  edgeGeometry,
} from "../src/client/board/edge-appearance";

const geometry = {
  sourceX: 0,
  sourceY: 0,
  targetX: 200,
  targetY: 100,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
};
describe("manual arrow bends", () => {
  it("moves the midpoint of a cubic curve through the requested waypoint", () => {
    const [path] = edgeGeometry(geometry, { path: "bezier" }, { x: 0, y: 60 });
    const n = path.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
    expect(n[0]).toBe(0);
    expect(n[1]).toBe(0);
    expect(n[6]).toBe(200);
    expect(n[7]).toBe(100);
    expect((n[0] + 3 * n[2] + 3 * n[4] + n[6]) / 8).toBeCloseTo(100);
    expect((n[1] + 3 * n[3] + 3 * n[5] + n[7]) / 8).toBeCloseTo(110);
  });
  it("keeps a bend relative to the endpoint midpoint during translation and resize", () => {
    expect(
      edgeBendPoint(geometry, { path: "bezier" }, { x: 20, y: 40 }),
    ).toEqual({ x: 120, y: 90 });
    expect(
      edgeBendPoint(
        { ...geometry, sourceX: 10, sourceY: 20, targetX: 210, targetY: 120 },
        { path: "bezier" },
        { x: 20, y: 40 },
      ),
    ).toEqual({ x: 130, y: 110 });
    expect(
      edgeBendPoint(
        { ...geometry, targetX: 300 },
        { path: "bezier" },
        { x: 20, y: 40 },
      ),
    ).toEqual({ x: 170, y: 90 });
  });
  it.each(
    Object.values(Position).flatMap((sourcePosition) =>
      Object.values(Position).map(
        (targetPosition) => [sourcePosition, targetPosition] as const,
      ),
    ),
  )(
    "deforms angular routes continuously for %s → %s",
    (sourcePosition, targetPosition) => {
      const inputs = { ...geometry, sourcePosition, targetPosition };
      const initial = edgeGeometry(inputs, { path: "smoothstep" })[0];
      const anchor = edgeBendPoint(inputs, { path: "smoothstep" });
      const unchanged = { x: anchor.x - 100, y: anchor.y - 50 };
      expect(edgeGeometry(inputs, { path: "smoothstep" }, unchanged)[0]).toBe(
        initial,
      );
      const moved = edgeGeometry(
        inputs,
        { path: "smoothstep" },
        { x: unchanged.x + 40, y: unchanged.y + 40 },
      )[0];
      expect(moved).not.toBe(initial);
      expect(moved).not.toMatch(/NaN|Infinity|C/);
    },
  );
});
