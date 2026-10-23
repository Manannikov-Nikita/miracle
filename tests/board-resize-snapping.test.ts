import { describe, expect, it } from "vitest";
import type { BoardNode } from "../src/shared/types";
import {
  snapResizedNode,
  type ResizeSides,
} from "../src/client/board/resize-snapping";

function node(
  id: string,
  x: number,
  y: number,
  width = 400,
  height = 300,
  kind: BoardNode["data"]["kind"] = "note",
): BoardNode {
  return {
    id,
    type: "artifact",
    position: { x, y },
    width,
    height,
    data: { title: id, kind },
  };
}

describe("board resize snapping", () => {
  it.each<
    [ResizeSides, BoardNode, BoardNode, BoardNode["position"], number, number]
  >([
    [
      { left: true },
      node("a", 104, 107, 396, 300),
      node("b", 100, 700),
      { x: 100, y: 107 },
      400,
      300,
    ],
    [
      { right: true },
      node("a", 100, 107, 396, 300),
      node("b", 500, 700),
      { x: 100, y: 107 },
      400,
      300,
    ],
    [
      { top: true },
      node("a", 107, 104, 400, 296),
      node("b", 700, 100),
      { x: 107, y: 100 },
      400,
      300,
    ],
    [
      { bottom: true },
      node("a", 107, 100, 400, 296),
      node("b", 700, 400),
      { x: 107, y: 100 },
      400,
      300,
    ],
  ])(
    "snaps only the active side %o and preserves its opposite anchor",
    (sides, moving, target, position, width, height) => {
      const nodes = [moving, target];
      const before = structuredClone(moving);
      const result = snapResizedNode(nodes, "a", sides, 1);
      expect(result.nodes[0]).toMatchObject({ position, width, height });
      expect(result.nodes[1]).toBe(target);
      expect(result.nodes[0].data).toBe(moving.data);
      expect(moving).toEqual(before);
      expect(result.guides).toHaveLength(1);
    },
  );

  it.each<[ResizeSides, number, number, number, number]>([
    [{ left: true, top: true }, 104, 104, 100, 100],
    [{ right: true, top: true }, 100, 104, 500, 100],
    [{ left: true, bottom: true }, 104, 100, 100, 400],
    [{ right: true, bottom: true }, 100, 100, 500, 400],
  ])(
    "snaps the corner %o while preserving both opposite edges",
    (sides, x, y, targetX, targetY) => {
      const result = snapResizedNode(
        [
          node("a", x, y, 396, 296),
          node("x", targetX, 700),
          node("y", 700, targetY),
        ],
        "a",
        sides,
        1,
      );
      expect(result.nodes[0]).toMatchObject({
        position: { x: 100, y: 100 },
        width: 400,
        height: 300,
      });
      expect(result.guides.map(({ coordinate }) => coordinate)).toEqual([
        targetX,
        targetY,
      ]);
    },
  );

  it("snaps both corner axes to different targets and spans final bounds in guides", () => {
    const moving = node("a", 104, 104, 396, 296);
    const result = snapResizedNode(
      [moving, node("x", 100, 700), node("y", 700, 100)],
      "a",
      { left: true, top: true },
      1,
    );
    expect(result.nodes[0]).toMatchObject({
      position: { x: 100, y: 100 },
      width: 400,
      height: 300,
    });
    expect(result.guides).toEqual([
      { axis: "x", coordinate: 100, from: 92, to: 1008 },
      { axis: "y", coordinate: 100, from: 92, to: 1108 },
    ]);
    expect(moving.position).toEqual({ x: 104, y: 104 });
    expect(moving.width).toBe(396);
  });

  it("snaps active edges to target centers", () => {
    const result = snapResizedNode(
      [node("a", 0, 0, 496, 396), node("b", 300, 250, 400, 300)],
      "a",
      { right: true, bottom: true },
      1,
    );
    expect(result.nodes[0]).toMatchObject({
      position: { x: 0, y: 0 },
      width: 500,
      height: 400,
    });
    expect(
      result.guides.map(({ axis, coordinate }) => [axis, coordinate]),
    ).toEqual([
      ["x", 500],
      ["y", 400],
    ]);
  });

  it.each([
    [2, 3, true],
    [2, 3.01, false],
    [0.5, 12, true],
    [0.5, 12.01, false],
  ])(
    "uses six screen pixels at zoom %s and offset %s",
    (zoom, offset, snaps) => {
      const nodes = [
        node("a", 0, 0, 500 + Number(offset)),
        node("b", 500, 700),
      ];
      const result = snapResizedNode(nodes, "a", { right: true }, Number(zoom));
      expect(result.nodes[0].width).toBe(snaps ? 500 : 500 + Number(offset));
      if (!snaps) expect(result.nodes).toBe(nodes);
    },
  );

  it.each([0, -1, NaN, Infinity])("defaults invalid zoom %s to one", (zoom) => {
    expect(
      snapResizedNode(
        [node("a", 0, 0, 505), node("b", 500, 700)],
        "a",
        { right: true },
        zoom,
      ).nodes[0].width,
    ).toBe(500);
  });

  it.each<[BoardNode["data"]["kind"], number, number]>([
    ["markdown", 240, 140],
    ["note", 280, 180],
    ["result", 280, 180],
  ])(
    "rejects targets below %s minimum size and uses the next legal targets",
    (kind, minWidth, minHeight) => {
      const moving = node("a", 100, 100, minWidth + 1, minHeight + 1, kind);
      const nodes = [
        moving,
        node("illegal-x", 99 + minWidth, 900),
        node("legal-x", 105 + minWidth, 900),
        node("illegal-y", 900, 99 + minHeight),
        node("legal-y", 900, 105 + minHeight),
      ];
      const result = snapResizedNode(
        nodes,
        "a",
        { right: true, bottom: true },
        1,
      );
      expect(result.nodes[0]).toMatchObject({
        position: { x: 100, y: 100 },
        width: minWidth + 5,
        height: minHeight + 5,
      });
    },
  );

  it("allows snapping exactly to minimum dimensions from left and top", () => {
    const result = snapResizedNode(
      [node("a", 96, 96, 284, 184), node("b", 100, 100)],
      "a",
      { left: true, top: true },
      1,
    );
    expect(result.nodes[0]).toMatchObject({
      position: { x: 100, y: 100 },
      width: 280,
      height: 180,
    });
  });

  it("leaves geometry untouched when only illegal targets are nearby", () => {
    const nodes = [node("a", 100, 100, 281, 181), node("b", 379, 279)];
    expect(
      snapResizedNode(nodes, "a", { right: true, bottom: true }, 1),
    ).toEqual({ nodes, guides: [] });
  });

  it("uses only the active edge rather than the node center or fixed opposite edge", () => {
    const nodes = [
      node("a", 100, 100, 400, 300),
      node("b", 103, 103, 20, 20),
      node("c", 293, 243, 20, 20),
    ];
    expect(
      snapResizedNode(nodes, "a", { right: true, bottom: true }, 1),
    ).toEqual({ nodes, guides: [] });
  });

  it("breaks nearest ties by coordinate and target id independently of node order", () => {
    const moving = node("a", 0, 0, 500);
    const targets = [
      node("z", 504, 900),
      node("b", 496, 700),
      node("c", 496, 500),
    ];
    const first = snapResizedNode(
      [moving, ...targets],
      "a",
      { right: true },
      1,
    );
    const second = snapResizedNode(
      [moving, ...targets.toReversed()],
      "a",
      { right: true },
      1,
    );
    expect(first.nodes[0].width).toBe(496);
    expect(first.guides).toEqual([
      { axis: "x", coordinate: 496, from: -8, to: 1008 },
    ]);
    expect(second.guides).toEqual(first.guides);
  });

  it("keeps array identity when aligned while displaying the active guide", () => {
    const nodes = [node("a", 0, 0, 500), node("b", 500, 700)];
    const result = snapResizedNode(nodes, "a", { right: true }, 1);
    expect(result.nodes).toBe(nodes);
    expect(result.guides).toHaveLength(1);
  });

  it("uses the same 480 by 300 fallback dimensions as movement snapping", () => {
    const {
      width: _width,
      height: _height,
      ...unsizedTarget
    } = node("b", 300, 250);
    const {
      width: _movingWidth,
      height: _movingHeight,
      ...unsizedMoving
    } = node("a", 64, 104);
    const result = snapResizedNode(
      [unsizedMoving, unsizedTarget],
      "a",
      { right: true, bottom: true },
      1,
    );
    expect(result.nodes[0]).toMatchObject({
      position: { x: 64, y: 104 },
      width: 476,
      height: 296,
    });
  });

  it("does not snap to itself, missing nodes, inactive sides, or distant candidates", () => {
    const self = [node("a", 0, 0)];
    const nodes = [...self, node("b", 900, 900)];
    for (const result of [
      snapResizedNode(self, "a", { right: true }, 1),
      snapResizedNode(nodes, "missing", { right: true }, 1),
      snapResizedNode(nodes, "a", {}, 1),
      snapResizedNode(nodes, "a", { right: true }, 1),
    ]) {
      expect(result.guides).toEqual([]);
      expect(result.nodes).toBe(result.nodes.length === 1 ? self : nodes);
    }
  });
});
