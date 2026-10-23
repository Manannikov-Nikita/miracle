import { describe, expect, it } from "vitest";
import type { BoardNode } from "../src/shared/types";
import {
  alignBoardNodes,
  snapBoardNodes,
  type AlignmentAction,
} from "../src/client/board/alignment";

function node(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 80,
): BoardNode {
  return {
    id,
    type: "artifact",
    position: { x, y },
    width,
    height,
    data: { title: id, kind: "note" },
  };
}

const selected = new Set(["a", "b", "c"]);

describe("board alignment", () => {
  it.each<[AlignmentAction, number[], number[]]>([
    ["left", [-120, -120, -120], [-70, 40, 160]],
    ["center-x", [80, 100, 40], [-70, 40, 160]],
    ["right", [280, 320, 200], [-70, 40, 160]],
    ["top", [-120, 80, 200], [-70, -70, -70]],
    ["center-y", [-120, 80, 200], [65, 85, 45]],
    ["bottom", [-120, 80, 200], [200, 240, 160]],
  ])(
    "aligns %s using the selected bounds and each node's size",
    (action, xs, ys) => {
      const nodes = [
        node("a", -120, -70, 100, 80),
        node("b", 80, 40, 60, 40),
        node("c", 200, 160, 180, 120),
        node("other", 900, 900),
      ];
      const result = alignBoardNodes(nodes, selected, action);
      expect(result.slice(0, 3).map((n) => n.position.x)).toEqual(xs);
      expect(result.slice(0, 3).map((n) => n.position.y)).toEqual(ys);
      expect(result[3]).toBe(nodes[3]);
      expect(nodes[0].position).toEqual({ x: -120, y: -70 });
      expect(result[0].data).toBe(nodes[0].data);
    },
  );

  it.each(["distribute-x", "distribute-y"] as const)(
    "equalizes edge gaps for unequal sizes with %s",
    (action) => {
      const horizontal = action === "distribute-x";
      const nodes = horizontal
        ? [
            node("c", 500, 9, 150),
            node("a", -100, 10, 100),
            node("b", 110, 11, 50),
          ]
        : [
            node("c", 9, 500, 10, 150),
            node("a", 10, -100, 10, 100),
            node("b", 11, 110, 10, 50),
          ];
      const result = alignBoardNodes(nodes, selected, action);
      expect(result[0]).toBe(nodes[0]);
      expect(result[1]).toBe(nodes[1]);
      expect(result[2].position).toEqual(
        horizontal ? { x: 225, y: 11 } : { x: 11, y: 225 },
      );
    },
  );

  it("uses default dimensions for nodes without stored sizes", () => {
    const first = node("a", -100, -100);
    const { width: _, height: __, ...unsized } = first;
    const nodes = [unsized, node("b", 20, 20)];
    expect(
      alignBoardNodes(nodes, new Set(["a", "b"]), "right")[1].position.x,
    ).toBe(280);
    expect(
      alignBoardNodes(nodes, new Set(["a", "b"]), "bottom")[1].position.y,
    ).toBe(120);
  });

  it("returns the original array for insufficient selections and already aligned nodes", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 200)];
    expect(alignBoardNodes(nodes, new Set(["a", "missing"]), "left")).toBe(
      nodes,
    );
    expect(alignBoardNodes(nodes, new Set(["a", "b"]), "left")).toBe(nodes);
    expect(alignBoardNodes(nodes, new Set(["a", "b"]), "distribute-y")).toBe(
      nodes,
    );
    const spaced = [node("a", 0, 0), node("b", 150, 0), node("c", 300, 0)];
    expect(alignBoardNodes(spaced, selected, "distribute-x")).toBe(spaced);
  });
});

describe("board drag snapping", () => {
  it("snaps edges at negative positions and returns a guide spanning both nodes", () => {
    const nodes = [node("moving", -96, -97), node("fixed", -100, 100)];
    const result = snapBoardNodes(nodes, new Set(["moving"]), 1);
    expect(result.nodes[0].position).toEqual({ x: -100, y: -97 });
    expect(result.nodes[1]).toBe(nodes[1]);
    expect(result.guides).toEqual([
      { axis: "x", coordinate: -100, from: -105, to: 188 },
    ]);
    expect(nodes[0].position).toEqual({ x: -96, y: -97 });
  });

  it("snaps a group bounding box uniformly to a stationary center", () => {
    const nodes = [
      node("a", 146, 297, 30, 20),
      node("b", 216, 337, 30, 20),
      node("fixed", 0, 100, 200, 200),
    ];
    const result = snapBoardNodes(nodes, new Set(["a", "b"]), 1);
    expect(result.nodes[0].position).toEqual({ x: 150, y: 300 });
    expect(result.nodes[1].position).toEqual({ x: 220, y: 340 });
    expect(
      result.guides.map((guide) => [guide.axis, guide.coordinate]),
    ).toEqual([
      ["x", 200],
      ["y", 300],
    ]);
  });

  it.each([
    [2, 3, true],
    [2, 3.01, false],
    [0.5, 12, true],
    [0.5, 12.01, false],
  ])(
    "uses six screen pixels as the threshold at zoom %s with offset %s",
    (zoom, offset, snaps) => {
      const nodes = [
        node("a", 500 + offset, 500),
        node("fixed", 0, 0, 500, 100),
      ];
      const result = snapBoardNodes(nodes, new Set(["a"]), zoom);
      expect(result.nodes[0].position.x).toBe(snaps ? 500 : 500 + offset);
      if (!snaps) expect(result.nodes).toBe(nodes);
    },
  );

  it.each([0, -1, NaN, Infinity])("defaults invalid zoom %s to one", (zoom) => {
    const nodes = [node("a", 505, 500), node("fixed", 0, 0, 500, 100)];
    expect(
      snapBoardNodes(nodes, new Set(["a"]), zoom).nodes[0].position.x,
    ).toBe(500);
  });

  it("does not snap members of a moving group to one another", () => {
    const nodes = [node("a", 3, 3), node("b", 105, 105)];
    const result = snapBoardNodes(nodes, new Set(["a", "b"]), 1);
    expect(result.nodes).toBe(nodes);
    expect(result.guides).toEqual([]);
  });

  it("returns an unchanged array when no moving node exists or no candidate is close", () => {
    const nodes = [node("a", 500, 500), node("fixed", 0, 0)];
    expect(snapBoardNodes(nodes, new Set(), 1)).toEqual({ nodes, guides: [] });
    expect(snapBoardNodes(nodes, new Set(["missing"]), 1).nodes).toBe(nodes);
    expect(snapBoardNodes(nodes, new Set(["a"]), 1).nodes).toBe(nodes);
  });

  it("chooses the nearest candidate deterministically regardless of document order", () => {
    const moving = node("a", 100, 500);
    const fixed = [node("right", 104, 0), node("left", 96, 200)];
    const first = snapBoardNodes([moving, ...fixed], new Set(["a"]), 1);
    const second = snapBoardNodes(
      [moving, ...fixed.toReversed()],
      new Set(["a"]),
      1,
    );
    expect(first.nodes[0].position.x).toBe(96);
    expect(second.nodes[0].position.x).toBe(96);
    expect(second.guides).toEqual(first.guides);
  });

  it("preserves identity when already snapped while still displaying a guide", () => {
    const nodes = [node("a", 100, 500), node("fixed", 100, 0)];
    const result = snapBoardNodes(nodes, new Set(["a"]), 1);
    expect(result.nodes).toBe(nodes);
    expect(result.guides).toHaveLength(1);
  });

  it("uses default node dimensions for snapping centers", () => {
    const { width: _, height: __, ...unsized } = node("fixed", 0, 0);
    const nodes = [node("a", 236, 500, 20, 20), unsized];
    expect(snapBoardNodes(nodes, new Set(["a"]), 1).nodes[0].position.x).toBe(
      240,
    );
  });
});
