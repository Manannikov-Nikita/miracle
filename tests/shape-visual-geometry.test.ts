import { describe, expect, it } from "vitest";
import type { BoardNode } from "../src/shared/types";
import type { ShapeSpec } from "../src/shared/shapes";
import {
  getLineGeometry,
  getNodeVisualBounds,
} from "../src/client/board/shape-geometry";

function shapeNode(shape: ShapeSpec, width = 260, height = 40): BoardNode {
  return {
    id: "shape",
    type: "artifact",
    position: { x: 100, y: 200 },
    width,
    height,
    data: { kind: "shape", title: "Shape", shape },
  };
}

describe("painted shape bounds", () => {
  it("uses the thin painted line instead of its old forty-pixel container", () => {
    const node = shapeNode({ type: "line" });
    expect(getNodeVisualBounds(node)).toEqual({
      x: 102,
      y: 219,
      right: 358,
      bottom: 221,
    });
    expect(node.position).toEqual({ x: 100, y: 200 });
    expect(node.height).toBe(40);
  });

  it("preserves old arrow tips and includes the solid head in the bounds", () => {
    const line = getLineGeometry({ type: "line", lineEnd: "arrow" }, 260, 40);
    expect(line.start.x).toBeCloseTo(5.6);
    expect(line.end.x).toBeCloseTo(254.4);
    expect(line.shaftEnd.x).toBeCloseTo(246.4);
    expect(line.endHead?.[0]).toEqual(line.end);
    expect(line.bounds.y).toBeCloseTo(16.4);
    expect(line.bounds.bottom).toBeCloseTo(23.6);
    expect(line.bounds.right).toBeCloseTo(254.4);
  });

  it("accounts for round dotted caps but does not extend butt caps", () => {
    const solid = getLineGeometry({ type: "line", strokeWidth: 4 }, 260, 40);
    const dotted = getLineGeometry(
      { type: "line", strokeWidth: 4, strokeStyle: "dotted" },
      260,
      40,
    );
    expect(solid.bounds).toEqual({ x: 3, y: 18, right: 257, bottom: 22 });
    // The last dot is centered at x=253; the trailing gap is not painted.
    expect(dotted.bounds).toEqual({ x: 1, y: 18, right: 255, bottom: 22 });
  });

  it("excludes the trailing empty gap of a thick dotted shaft", () => {
    const shape: ShapeSpec = {
      type: "line",
      strokeWidth: 12,
      strokeStyle: "dotted",
    };
    expect(getLineGeometry(shape, 220, 40).bounds).toEqual({
      x: 1,
      y: 14,
      right: 193,
      bottom: 26,
    });
    const rotated = getNodeVisualBounds(
      shapeNode({ ...shape, rotation: 90 }, 220, 40),
    );
    expect(rotated.x).toBeCloseTo(204);
    expect(rotated.y).toBeCloseTo(111);
    expect(rotated.right).toBeCloseTo(216);
    expect(rotated.bottom).toBeCloseTo(303);
  });

  it.each([
    ["vertical", 40, 220, { x: 14, y: 1, right: 26, bottom: 193 }],
    ["diagonal-down", 194, 254, { x: 1, y: 1, right: 175, bottom: 229 }],
    ["diagonal-up", 194, 254, { x: 1, y: 25, right: 175, bottom: 253 }],
  ] as const)(
    "keeps %s dotted bounds at the last actual dot",
    (lineDirection, width, height, expected) => {
      const actual = getLineGeometry(
        { type: "line", lineDirection, strokeWidth: 12, strokeStyle: "dotted" },
        width,
        height,
      ).bounds;
      for (const edge of ["x", "y", "right", "bottom"] as const)
        expect(actual[edge]).toBeCloseTo(expected[edge]);
    },
  );

  it("excludes a trailing dash gap but includes a partially painted last dash", () => {
    const shape: ShapeSpec = {
      type: "line",
      strokeWidth: 12,
      strokeStyle: "dashed",
    };
    expect(getLineGeometry(shape, 220, 40).bounds).toEqual({
      x: 7,
      y: 14,
      right: 199,
      bottom: 26,
    });
    expect(getLineGeometry(shape, 200, 40).bounds).toEqual({
      x: 7,
      y: 14,
      right: 193,
      bottom: 26,
    });
    // Ending exactly at a new dash's start does not paint a butt-capped dash.
    expect(getLineGeometry(shape, 230, 40).bounds).toEqual({
      x: 7,
      y: 14,
      right: 199,
      bottom: 26,
    });
  });

  it("retains the solid arrowhead beyond the last dotted shaft segment", () => {
    const line = getLineGeometry(
      {
        type: "line",
        strokeWidth: 12,
        strokeStyle: "dotted",
        lineEnd: "arrow",
      },
      220,
      40,
    );
    expect(line.end.x).toBeCloseTo(206.7);
    expect(line.bounds.right).toBeCloseTo(206.7);
    expect(line.bounds.x).toBeCloseTo(7.3);
    expect(line.bounds.y).toBeCloseTo(13.7);
    expect(line.bounds.bottom).toBeCloseTo(26.3);
  });

  it("keeps zero-length round caps finite when tiny endpoints coincide in world space", () => {
    const bounds = getNodeVisualBounds(
      shapeNode(
        { type: "line", strokeWidth: 12, strokeStyle: "dotted" },
        Number.MIN_VALUE,
        40,
      ),
    );
    expect(bounds).toEqual({ x: 94, y: 214, right: 106, bottom: 226 });
  });

  it("rotates the actual stroke around the saved layout center", () => {
    const bounds = getNodeVisualBounds(
      shapeNode({ type: "line", rotation: 90 }),
    );
    expect(bounds.x).toBeCloseTo(229);
    expect(bounds.right).toBeCloseTo(231);
    expect(bounds.y).toBeCloseTo(92);
    expect(bounds.bottom).toBeCloseTo(348);
  });

  it("bounds a diagonal butt-capped stroke by its normal, not by square end caps", () => {
    const line = getLineGeometry(
      { type: "line", lineDirection: "diagonal-down", strokeWidth: 4 },
      100,
      100,
    );
    expect(line.bounds.x).toBeCloseTo(3 - Math.sqrt(2));
    expect(line.bounds.y).toBeCloseTo(3 - Math.sqrt(2));
    expect(line.bounds.right).toBeCloseTo(97 + Math.sqrt(2));
    expect(line.bounds.bottom).toBeCloseTo(97 + Math.sqrt(2));
    const rotated = getNodeVisualBounds(
      shapeNode(
        {
          type: "line",
          lineDirection: "diagonal-down",
          strokeWidth: 4,
          rotation: 45,
        },
        100,
        100,
      ),
    );
    expect(rotated.x).toBeCloseTo(148);
    expect(rotated.right).toBeCloseTo(152);
    expect(rotated.y).toBeCloseTo(250 - 47 * Math.sqrt(2));
    expect(rotated.bottom).toBeCloseTo(250 + 47 * Math.sqrt(2));
  });

  it("does not stretch arrowheads when the node becomes wider", () => {
    const headSize = (width: number, height: number) => {
      const head = getLineGeometry(
        { type: "line", lineEnd: "arrow" },
        width,
        height,
      ).endHead!;
      return {
        width:
          Math.max(...head.map((p) => p.x)) - Math.min(...head.map((p) => p.x)),
        height:
          Math.max(...head.map((p) => p.y)) - Math.min(...head.map((p) => p.y)),
      };
    };
    expect(headSize(780, 120)).toEqual(headSize(260, 40));
  });

  it("uses the rotated ellipse, not the corners of its rectangular frame", () => {
    const bounds = getNodeVisualBounds(
      shapeNode({ type: "ellipse", strokeWidth: 0, rotation: 45 }, 100, 20),
    );
    const radius = Math.sqrt(1300);
    expect(bounds.x).toBeCloseTo(150 - radius);
    expect(bounds.right).toBeCloseTo(150 + radius);
    expect(bounds.y).toBeCloseTo(210 - radius);
    expect(bounds.bottom).toBeCloseTo(210 + radius);
  });

  it("uses asymmetric rotated triangle extrema", () => {
    const bounds = getNodeVisualBounds(
      shapeNode({ type: "triangle", strokeWidth: 0, rotation: 45 }, 100, 100),
    );
    expect(bounds.x).toBeCloseTo(150 - Math.sqrt(5000));
    expect(bounds.right).toBeCloseTo(150 + Math.sqrt(1250));
    expect(bounds.y).toBeCloseTo(250 - Math.sqrt(1250));
    expect(bounds.bottom).toBeCloseTo(250 + Math.sqrt(5000));
  });

  it("keeps ordinary card bounds unchanged and rotated rounded corners tight", () => {
    const card = shapeNode({ type: "rectangle" }, 100, 60);
    card.data = { kind: "note", title: "Note" };
    expect(getNodeVisualBounds(card)).toEqual({
      x: 100,
      y: 200,
      right: 200,
      bottom: 260,
    });
    const bounds = getNodeVisualBounds(
      shapeNode(
        {
          type: "rounded-rectangle",
          cornerRadius: 25,
          strokeWidth: 0,
          rotation: 45,
        },
        100,
        60,
      ),
    );
    const radius = 40 / Math.sqrt(2) + Math.sqrt(425);
    expect(bounds.x).toBeCloseTo(150 - radius);
    expect(bounds.y).toBeCloseTo(230 - radius);
    expect(bounds.right).toBeCloseTo(150 + radius);
    expect(bounds.bottom).toBeCloseTo(230 + radius);
  });

  it.each(["horizontal", "vertical", "diagonal-up", "diagonal-down"] as const)(
    "keeps thick %s two-headed arrows inside their old frame",
    (lineDirection) => {
      const result = getLineGeometry(
        {
          type: "line",
          lineDirection,
          lineStart: "arrow",
          lineEnd: "arrow",
          strokeWidth: 12,
        },
        40,
        40,
      );
      expect(result.bounds.x).toBeGreaterThanOrEqual(0);
      expect(result.bounds.y).toBeGreaterThanOrEqual(0);
      expect(result.bounds.right).toBeLessThanOrEqual(40);
      expect(result.bounds.bottom).toBeLessThanOrEqual(40);
    },
  );

  it("keeps an invisible line finite without inventing a wide visible box", () => {
    const result = getLineGeometry({ type: "line", strokeWidth: 0 }, 260, 40);
    expect(result.bounds).toEqual({ x: 1, y: 20, right: 259, bottom: 20 });
    expect(result.startHead).toBeUndefined();
    expect(result.endHead).toBeUndefined();
  });

  it("keeps subprecision dash spacing finite", () => {
    const bounds = getLineGeometry(
      { type: "line", strokeWidth: Number.MIN_VALUE, strokeStyle: "dotted" },
      260,
      40,
    ).bounds;
    expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
  });
});
