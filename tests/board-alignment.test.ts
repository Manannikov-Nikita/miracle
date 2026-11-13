import { describe, expect, it } from "vitest";
import type { BoardNode } from "../src/shared/types";
import type { ShapeSpec } from "../src/shared/shapes";
import {
  alignBoardNodes,
  snapBoardNodes,
  type AlignmentAction,
} from "../src/client/board/alignment";

const slideFrame = { x: 0, y: 0, right: 1600, bottom: 900 };

describe("slide edge drag snapping", () => {
  it.each([
    [4, 123, 0, 123, "x", 0],
    [1504, 123, 1500, 123, "x", 1600],
    [123, 4, 123, 0, "y", 0],
    [123, 824, 123, 820, "y", 900],
  ])(
    "snaps a lone block near each slide edge",
    (x, y, expectedX, expectedY, axis, coordinate) => {
      const original = node("a", Number(x), Number(y));
      const result = snapBoardNodes([original], new Set(["a"]), 1, slideFrame);
      expect(result.nodes[0].position).toEqual({ x: expectedX, y: expectedY });
      expect(result.nodes[0].data).toBe(original.data);
      expect(result.guides).toEqual([
        { axis, coordinate, from: 0, to: axis === "x" ? 900 : 1600 },
      ]);
    },
  );

  it("snaps the group bounds to a corner without changing internal spacing", () => {
    const nodes = [node("a", 3, 4), node("b", 203, 144)];
    const result = snapBoardNodes(nodes, new Set(["a", "b"]), 1, slideFrame);
    expect(result.nodes.map((item) => item.position)).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 140 },
    ]);
    expect(result.guides).toHaveLength(2);
  });

  it("uses screen distance and permits overflow outside the snap threshold", () => {
    const nodes = [node("a", -11, 123)];
    expect(
      snapBoardNodes(nodes, new Set(["a"]), 0.5, slideFrame).nodes[0].position
        .x,
    ).toBe(0);
    expect(snapBoardNodes(nodes, new Set(["a"]), 1, slideFrame).nodes).toBe(
      nodes,
    );
    expect(snapBoardNodes(nodes, new Set(["a"]), 0.5).nodes).toBe(nodes);
  });

  it("does not align a block center to the slide edge", () => {
    const nodes = [node("a", -49, 123)];
    expect(snapBoardNodes(nodes, new Set(["a"]), 1, slideFrame).nodes).toBe(
      nodes,
    );
  });

  it("prefers the nearest target and the slide edge for equal distances", () => {
    const moving = node("a", 4, 123);
    const closer = node("b", 3, 400);
    expect(
      snapBoardNodes([moving, closer], new Set(["a"]), 1, slideFrame).nodes[0]
        .position.x,
    ).toBe(3);
    const tied = node("b", 8, 400);
    const result = snapBoardNodes(
      [moving, tied],
      new Set(["a"]),
      1,
      slideFrame,
    );
    expect(result.nodes[0].position.x).toBe(0);
    expect(result.nodes[1]).toBe(tied);
  });
});

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

function shape(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  spec: ShapeSpec,
): BoardNode {
  return {
    ...node(id, x, y, width, height),
    data: { title: id, kind: "shape", shape: spec },
  };
}

describe("alignment by the painted shape", () => {
  it("aligns a rotated ellipse edge while preserving its saved layout offset", () => {
    const ellipse = shape("a", 100, 200, 200, 80, {
      type: "ellipse",
      rotation: 90,
      strokeWidth: 0,
    });
    const card = node("b", 20, 60, 80, 60);
    const result = alignBoardNodes(
      [ellipse, card],
      new Set(["a", "b"]),
      "left",
    );
    // The visible ellipse begins 60 units to the right of its saved layout x.
    expect(result[0].position.x).toBeCloseTo(-40);
    expect(result[0].position.y).toBe(200);
    expect(result[0].width).toBe(200);
    expect(result[0].height).toBe(80);
    expect(result[0].data).toBe(ellipse.data);
    expect(result[1]).toBe(card);
    expect(alignBoardNodes(result, new Set(["a", "b"]), "left")).toBe(result);
  });

  it("aligns a rotated triangle's actual vertex rather than its rotated rectangular frame", () => {
    const triangle = shape("a", 300, 200, 200, 100, {
      type: "triangle",
      rotation: 45,
      strokeWidth: 0,
    });
    const result = alignBoardNodes(
      [triangle, node("b", 20, 60, 80, 60)],
      new Set(["a", "b"]),
      "top",
    );
    const visibleTopOffset = 50 - 50 / Math.SQRT2;
    expect(result[0].position.y).toBeCloseTo(60 - visibleTopOffset);
    expect(result[0].position.x).toBe(300);
    expect(alignBoardNodes(result, new Set(["a", "b"]), "top")).toBe(result);
  });

  it("aligns the arrowhead bottom to a card rather than the empty line container", () => {
    const arrow = shape("a", 10, 100, 260, 40, {
      type: "line",
      lineEnd: "arrow",
    });
    const result = alignBoardNodes(
      [arrow, node("b", 400, 0, 80, 200)],
      new Set(["a", "b"]),
      "bottom",
    );
    // The 8-unit arrowhead is 7.2 units tall, centered at local y=20.
    expect(result[0].position.y).toBeCloseTo(200 - 23.6);
    expect(result[0].position.x).toBe(10);
    expect(result[0].height).toBe(40);
  });

  it("distributes cards from a line anchor with equal visible gaps and fixed outer anchors", () => {
    const first = shape("a", 0, 0, 260, 40, { type: "line" });
    const middle = node("b", 0, 80, 80, 20);
    const last = node("c", 0, 200, 80, 20);
    const result = alignBoardNodes(
      [first, middle, last],
      selected,
      "distribute-y",
    );
    // Visible span is 220 - 19, and occupied height is 2 + 20 + 20.
    expect(result[1].position.y).toBeCloseTo(100.5);
    expect(result[1].position.y - 21).toBeCloseTo(79.5);
    expect(200 - (result[1].position.y + 20)).toBeCloseTo(79.5);
    expect(result[0]).toBe(first);
    expect(result[2]).toBe(last);
  });

  it("snaps a card to the top of an arrowhead and spans only painted bounds", () => {
    const card = node("a", 400, 112, 80, 80);
    const arrow = shape("b", 0, 100, 260, 40, {
      type: "line",
      lineEnd: "arrow",
    });
    const result = snapBoardNodes([card, arrow], new Set(["a"]), 1);
    expect(result.nodes[0].position.y).toBeCloseTo(116.4);
    expect(result.guides).toHaveLength(1);
    expect(result.guides[0].axis).toBe("y");
    expect(result.guides[0].coordinate).toBeCloseTo(116.4);
    expect(result.guides[0].from).toBeCloseTo(-2.4);
    expect(result.guides[0].to).toBe(488);
    expect(result.nodes[1]).toBe(arrow);
  });

  it("moves a group uniformly when its thin line edge snaps to the slide frame", () => {
    const line = shape("a", 100, -16, 260, 40, { type: "line" });
    const card = node("b", 500, 100, 100, 80);
    const result = snapBoardNodes(
      [line, card],
      new Set(["a", "b"]),
      1,
      slideFrame,
    );
    // The first painted row is at y=3, despite the saved container starting at -16.
    expect(result.nodes[0].position.y).toBeCloseTo(-19);
    expect(result.nodes[1].position.y).toBeCloseTo(97);
    expect(result.guides).toEqual([
      { axis: "y", coordinate: 0, from: 0, to: 1600 },
    ]);
  });
});

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

describe("equal spacing while dragging", () => {
  const moving = new Set(["moving"]);
  const spacingGuides = (result: ReturnType<typeof snapBoardNodes>) =>
    result.guides.filter(
      (guide) => "kind" in guide && guide.kind === "spacing",
    );
  const gap = (
    axis: "x" | "y",
    coordinate: number,
    from: number,
    to: number,
  ) => ({
    kind: "spacing",
    axis,
    coordinate,
    from,
    to,
    distance: to - from,
  });

  it.each(["x", "y"] as const)(
    "centers the dragged node between unequal painted edges on the %s axis",
    (axis) => {
      const make = (
        id: string,
        main: number,
        cross: number,
        size: number,
        depth: number,
      ) =>
        axis === "x"
          ? node(id, main, cross, size, depth)
          : node(id, cross, main, depth, size);
      const dragged = make("moving", 23, 13, 60, 20);
      const first = make("before", -180, 0, 80, 80);
      const last = make("after", 200, 0, 100, 80);
      const result = snapBoardNodes([dragged, first, last], moving, 1);
      expect(result.nodes[0].position[axis]).toBe(20);
      expect(result.nodes[0].data).toBe(dragged.data);
      expect(result.nodes[1]).toBe(first);
      expect(result.nodes[2]).toBe(last);
      expect(spacingGuides(result)).toEqual([
        gap(axis, 23, -100, 20),
        gap(axis, 23, 80, 200),
      ]);
    },
  );

  it.each([
    {
      start: 179,
      expected: 175,
      gaps: [
        [-15, 30],
        [130, 175],
      ],
    },
    {
      start: -201,
      expected: -205,
      gaps: [
        [-125, -80],
        [-15, 30],
      ],
    },
  ])(
    "continues the neighboring row at $expected",
    ({ start, expected, gaps }) => {
      const nodes = [
        node("first", -80, 0, 65),
        node("moving", start, 0, 80),
        node("second", 30, 0, 100),
      ];
      const result = snapBoardNodes(nodes, moving, 1);
      expect(result.nodes[1].position.x).toBe(expected);
      expect(spacingGuides(result)).toEqual(
        gaps.map(([from, to]) => gap("x", 40, from, to)),
      );
    },
  );

  it.each([
    [2, 3, true],
    [2, 3.01, false],
    [0.5, 12, true],
    [0.5, 12.01, false],
  ])(
    "uses a six-screen-pixel spacing threshold at zoom %s and offset %s",
    (zoom, offset, snaps) => {
      const nodes = [
        node("first", 0, 0),
        node("moving", 200 + offset, 0),
        node("second", 400, 0),
      ];
      const result = snapBoardNodes(nodes, moving, zoom);
      expect(result.nodes[1].position.x).toBe(snaps ? 200 : 200 + offset);
      expect(spacingGuides(result)).toHaveLength(snaps ? 2 : 0);
    },
  );

  it("moves a selection by one offset using its unified visible bounds", () => {
    const nodes = [
      node("first", 0, 0),
      node("a", 203, 0, 40),
      node("b", 253, 0, 50),
      node("last", 400, 0),
    ];
    const result = snapBoardNodes(nodes, new Set(["a", "b"]), 1);
    expect(result.nodes.map((item) => item.position.x)).toEqual([
      0, 200, 250, 400,
    ]);
    expect(spacingGuides(result)).toEqual([
      gap("x", 40, 100, 200),
      gap("x", 40, 300, 400),
    ]);
  });

  it("measures a rotated ellipse from its visible horizontal edge", () => {
    const nodes = [
      shape("ellipse", 0, 0, 200, 80, {
        type: "ellipse",
        rotation: 90,
        strokeWidth: 0,
      }),
      node("moving", 243, 20, 60, 40),
      node("last", 400, 0),
    ];
    const result = snapBoardNodes(nodes, moving, 1);
    expect(result.nodes[1].position.x).toBeCloseTo(240);
    expect(spacingGuides(result)).toEqual([
      gap("x", 40, 140, 240),
      gap("x", 40, 300, 400),
    ]);
  });

  it("measures a thin line from the painted stroke instead of its container", () => {
    const nodes = [
      shape("line", 0, -20, 260, 40, { type: "line" }),
      node("moving", 50, 82, 80, 40),
      node("last", 50, 200),
    ];
    const result = snapBoardNodes(nodes, moving, 1);
    expect(result.nodes[1].position.y).toBeCloseTo(80.5);
    expect(spacingGuides(result)).toEqual([
      gap("y", 90, 1, 80.5),
      gap("y", 90, 120.5, 200),
    ]);
  });

  it.each([100, 190])(
    "does not measure through a blocker at x=%s",
    (blocker) => {
      const nodes = [
        node("first", 0, 0, 80),
        node("moving", 165, 0, 80),
        node("last", 320, 0, 80),
        node("blocker", blocker, 0, 30),
      ];
      expect(spacingGuides(snapBoardNodes(nodes, moving, 1))).toEqual([]);
    },
  );

  it("does not pair objects on separate rows even if both overlap the moving object", () => {
    const nodes = [
      node("first", 0, 0, 80, 30),
      node("moving", 163, 10, 80, 60),
      node("last", 320, 50, 80, 30),
    ];
    const result = snapBoardNodes(nodes, moving, 1);
    expect(result.nodes[1].position.x).toBe(163);
    expect(spacingGuides(result)).toEqual([]);
  });

  it("drops spacing when the final orthogonal anchor snap removes the common overlap", () => {
    const nodes = [
      node("first", 0, 9, 80, 40),
      node("moving", 163, 0, 80, 10),
      node("last", 320, 9, 80, 40),
    ];
    const result = snapBoardNodes(nodes, moving, 1);
    expect(result.nodes[1].position).toEqual({ x: 163, y: -1 });
    expect(spacingGuides(result)).toEqual([]);
  });

  it.each([
    [164, 168, 168, 0],
    [163, 167, 160, 2],
  ])(
    "compares spacing with the nearest alignment anchor, preferring alignment on a tie",
    (start, anchor, expected, count) => {
      const nodes = [
        node("first", 0, 0, 80),
        node("moving", start, 0, 80),
        node("last", 320, 0, 80),
        node("anchor", anchor, 200, 80),
      ];
      const result = snapBoardNodes(nodes, moving, 1);
      expect(result.nodes[1].position.x).toBe(expected);
      expect(spacingGuides(result)).toHaveLength(count);
    },
  );

  it("breaks ties between separate spacing candidates independently of document order", () => {
    const dragged = node("moving", 164, 0, 80, 200);
    const fixed = [
      node("first-top", 0, 0, 80, 40),
      node("last-top", 320, 0, 80, 40),
      node("first-bottom", 0, 160, 96, 40),
      node("last-bottom", 320, 160, 80, 40),
    ];
    const result = snapBoardNodes([dragged, ...fixed], moving, 1);
    const reversed = snapBoardNodes(
      [dragged, ...fixed.toReversed()],
      moving,
      1,
    );
    expect(result.nodes[0].position.x).toBe(160);
    expect(reversed.nodes[0].position).toEqual(result.nodes[0].position);
    expect(spacingGuides(reversed)).toEqual(spacingGuides(result));
  });

  it.each([160, 163])(
    "shows both hints when spacing and alignment meet at the same position (from %s)",
    (start) => {
      const nodes = [
        node("first", 0, 0, 80),
        node("moving", start, 0, 80),
        node("last", 320, 0, 80),
        node("anchor", 160, 200, 80),
      ];
      const result = snapBoardNodes(nodes, moving, 1);
      expect(result.nodes[1].position.x).toBe(160);
      expect(result.guides).toContainEqual({
        axis: "x",
        coordinate: 160,
        from: -8,
        to: 288,
      });
      expect(spacingGuides(result)).toEqual([
        gap("x", 40, 80, 160),
        gap("x", 40, 240, 320),
      ]);
    },
  );
});
