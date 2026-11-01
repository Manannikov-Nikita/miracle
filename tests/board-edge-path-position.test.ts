import { describe, expect, it } from "vitest";
import {
  closestPathPosition,
  pointAlongPath,
  type PathMeasurement,
} from "../src/client/board/edge-geometry";

describe("labels along curved arrow paths", () => {
  // A quarter-circle provides exact arc-length coordinates independent of the
  // implementation's search. Projecting onto its straight chord would be wrong.
  const arc = {
    getTotalLength: () => Math.PI * 50,
    getPointAtLength: (distance: number) => ({
      x: 100 * Math.cos(distance / 100),
      y: 100 * Math.sin(distance / 100),
    }),
  } as PathMeasurement;
  it("projects a dragged label onto the curve using normalized arc length", () => {
    const position = closestPathPosition(arc, { x: 50, y: 86.6025403784 });
    expect(position).toBeCloseTo(2 / 3, 3);
    expect(pointAlongPath(arc, 0.5)).toEqual({
      x: expect.closeTo(70.710678, 4),
      y: expect.closeTo(70.710678, 4),
    });
  });
  it("keeps projected labels at the nearest endpoint outside the path", () => {
    expect(closestPathPosition(arc, { x: 150, y: -50 })).toBe(0);
    expect(closestPathPosition(arc, { x: -50, y: 150 })).toBe(1);
  });
  it("does not produce a write position for an empty path", () => {
    expect(
      closestPathPosition(
        {
          getTotalLength: () => 0,
          getPointAtLength: () => ({ x: 0, y: 0 }),
        } as PathMeasurement,
        { x: 10, y: 10 },
      ),
    ).toBeUndefined();
  });
});
