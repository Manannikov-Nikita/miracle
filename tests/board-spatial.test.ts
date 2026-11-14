import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyBoardSpatial } from "../src/server/board-agent";
import { Database, migrate } from "../src/server/db";
import { ProjectStore } from "../src/server/project-store";
import { SecretBox } from "../src/server/secrets";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import type { Board, BoardNode } from "../src/shared/types";

let root: string, db: Database, store: ProjectStore, ops: WorkspaceOperations;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miracle-board-spatial-"));
  db = new Database(join(root, ".miracle"));
  migrate(db, () => {});
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: root,
    dataDir: db.dataDir,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  ops = new WorkspaceOperations(store, async () => {});
});
afterEach(() => {
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function note(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): BoardNode {
  return {
    id,
    type: "artifact",
    position: { x, y },
    width,
    height,
    data: { kind: "note", title: id },
  };
}
function board(...nodes: BoardNode[]) {
  return ops.createBoard({
    name: "Board",
    document: { schemaVersion: 1, nodes, edges: [] },
  });
}
const arrow: BoardNode = {
  ...note("arrow", 10, 100, 260, 40),
  data: {
    kind: "shape",
    title: "Arrow",
    shape: { type: "line", lineEnd: "arrow" },
  },
};
function request(base: Board, ...operations: unknown[]) {
  return {
    id: base.id,
    baseRevision: base.revision,
    mutationId: randomUUID(),
    operations,
  };
}

it("aligns the bottom of a painted arrowhead to an unchanged card", () => {
  const base = board(arrow, note("anchor", 400, 0, 80, 200));
  const receipt = applyBoardSpatial(
    ops,
    request(base, {
      type: "align",
      action: "bottom",
      nodeIds: ["arrow", "anchor"],
    }),
  );
  expect(receipt).toEqual({
    id: base.id,
    revision: base.revision + 1,
    changed: [
      expect.objectContaining({
        id: "arrow",
        position: { x: 10, y: expect.closeTo(176.4) },
        bounds: {
          x: expect.closeTo(15.6),
          right: expect.closeTo(264.4),
          y: expect.closeTo(192.8),
          bottom: expect.closeTo(200),
        },
      }),
    ],
  });
  const stored = ops.board(base.id).document.nodes;
  expect(stored[0].position.y).toBeCloseTo(176.4);
  expect(stored[1]).toEqual(base.document.nodes[1]);
});

it("distributes unequal items using equal visible gaps with both outer anchors fixed", () => {
  const line: BoardNode = {
    ...arrow,
    position: { x: 0, y: 0 },
    data: { ...arrow.data, shape: { type: "line" } },
  };
  const base = board(
    line,
    note("middle", 5, 80, 80, 20),
    note("last", 0, 200, 80, 20),
  );
  const result = applyBoardSpatial(
    ops,
    request(base, {
      type: "distribute",
      axis: "y",
      nodeIds: ["last", "middle", "arrow"],
    }),
  );
  expect(result.changed.map(({ id }) => id)).toEqual(["middle"]);
  expect(result.changed[0].position).toEqual({ x: 5, y: 100.5 });
  expect(ops.board(base.id).document.nodes[0]).toEqual(base.document.nodes[0]);
  expect(ops.board(base.id).document.nodes[2]).toEqual(base.document.nodes[2]);
});

it("places the painted corner and keeps it fixed through a resize", () => {
  const ellipse: BoardNode = {
    ...note("ellipse", 100, 200, 200, 80),
    data: {
      kind: "shape",
      title: "Ellipse",
      shape: { type: "ellipse", rotation: 90, strokeWidth: 0 },
    },
  };
  const base = board(ellipse);
  const receipt = applyBoardSpatial(
    ops,
    request(
      base,
      { type: "place", id: "ellipse", x: 20, y: 60 },
      {
        type: "resize",
        id: "ellipse",
        width: 240,
        height: 120,
        anchor: "top-left",
      },
    ),
  );
  expect(receipt.changed).toEqual([
    expect.objectContaining({
      id: "ellipse",
      width: 240,
      height: 120,
      position: { x: -40, y: 120 },
      bounds: { x: 20, y: 60, right: 140, bottom: 300 },
    }),
  ]);
});

it("rejects a stale alignment even when only its read-only anchor changed", () => {
  const base = board(arrow, note("anchor", 400, 0, 80, 200));
  const stale = request(base, {
    type: "align",
    action: "bottom",
    nodeIds: ["arrow"],
    anchorId: "anchor",
  });
  applyBoardSpatial(
    ops,
    request(base, { type: "move", nodeIds: ["anchor"], dx: 0, dy: 100 }),
  );
  expect(() => applyBoardSpatial(ops, stale)).toThrow(
    expect.objectContaining({ code: "REVISION_CONFLICT" }),
  );
  expect(ops.board(base.id).document.nodes[0]).toEqual(base.document.nodes[0]);
});

it("replays the original receipt after another mutation without applying movement twice", () => {
  const base = board(arrow, note("anchor", 400, 0, 80, 200));
  const first = request(base, {
    type: "move",
    nodeIds: ["anchor"],
    dx: 0,
    dy: 100,
  });
  const receipt = applyBoardSpatial(ops, first);
  applyBoardSpatial(
    ops,
    request(ops.board(base.id), {
      type: "move",
      nodeIds: ["anchor"],
      dx: 50,
      dy: 0,
    }),
  );
  expect(applyBoardSpatial(ops, first)).toEqual(receipt);
  expect(ops.board(base.id).document.nodes[1].position).toEqual({
    x: 450,
    y: 100,
  });
  expect(() =>
    applyBoardSpatial(ops, {
      ...first,
      operations: [{ type: "move", nodeIds: ["anchor"], dx: 0, dy: 101 }],
    }),
  ).toThrow(expect.objectContaining({ code: "MUTATION_CONFLICT" }));
});

it("rolls back the batch when a later move would take a node out of range", () => {
  const base = board(arrow, note("anchor", 999999, 0, 80, 200));
  expect(() =>
    applyBoardSpatial(
      ops,
      request(
        base,
        { type: "move", nodeIds: ["arrow"], dx: 100, dy: 0 },
        { type: "move", nodeIds: ["anchor"], dx: 10, dy: 0 },
      ),
    ),
  ).toThrow(
    expect.objectContaining({ code: "BOARD_COORDINATES_OUT_OF_RANGE" }),
  );
  expect(ops.board(base.id)).toEqual(base);
});

it("honors an exclusive lock on an anchor even when it will not be written", () => {
  const base = board(arrow, note("anchor", 400, 0, 80, 200));
  store.work.runAs(
    { turnId: randomUUID(), chatId: randomUUID(), isActive: () => true },
    () => {
      store.work.begin([
        { kind: "board-node", boardId: base.id, id: "anchor" },
      ]);
    },
  );
  expect(() =>
    applyBoardSpatial(
      ops,
      request(base, {
        type: "align",
        action: "bottom",
        nodeIds: ["arrow"],
        anchorId: "anchor",
      }),
    ),
  ).toThrow(expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }));
  expect(ops.board(base.id)).toEqual(base);
});

it("rejects alignment between elements on different slides atomically", () => {
  const base = ops.createBoard({
    name: "Presentation",
    document: {
      schemaVersion: 1,
      kind: "presentation",
      slides: [
        { id: "first", title: "First", background: "#ffffff" },
        { id: "second", title: "Second", background: "#ffffff" },
      ],
      nodes: [
        { ...arrow, slideId: "first" },
        { ...note("anchor", 400, 0, 80, 200), slideId: "second" },
      ],
      edges: [],
    },
  });
  expect(() =>
    applyBoardSpatial(
      ops,
      request(base, {
        type: "align",
        action: "bottom",
        nodeIds: ["arrow"],
        anchorId: "anchor",
      }),
    ),
  ).toThrow(expect.objectContaining({ code: "BOARD_SLIDE_MISMATCH" }));
  expect(ops.board(base.id)).toEqual(base);
});

it("moves the selected object to an explicit interior anchor instead of the selection envelope", () => {
  const base = board(arrow, note("anchor", 400, 20, 80, 20));
  const receipt = applyBoardSpatial(
    ops,
    request(base, {
      type: "align",
      action: "bottom",
      nodeIds: ["arrow", "anchor"],
      anchorId: "anchor",
    }),
  );
  expect(receipt.changed.map(({ id }) => id)).toEqual(["arrow"]);
  expect(receipt.changed[0].position.y).toBeCloseTo(16.4);
  expect(receipt.changed[0].bounds.bottom).toBeCloseTo(40);
  expect(ops.board(base.id).document.nodes[1]).toEqual(base.document.nodes[1]);
});

it("checks a locked incident edge before indirectly moving either of its ends", () => {
  const base = ops.createBoard({
    name: "Linked",
    document: {
      schemaVersion: 1,
      nodes: [arrow, note("anchor", 400, 0, 80, 200)],
      edges: [{ id: "edge", source: "arrow", target: "anchor" }],
    },
  });
  store.work.runAs(
    { turnId: randomUUID(), chatId: randomUUID(), isActive: () => true },
    () => {
      store.work.begin([{ kind: "board-edge", boardId: base.id, id: "edge" }]);
    },
  );
  expect(() =>
    applyBoardSpatial(
      ops,
      request(base, { type: "move", nodeIds: ["arrow"], dx: 100, dy: 0 }),
    ),
  ).toThrow(expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }));
  expect(ops.board(base.id)).toEqual(base);
});

it("rejects an explicit resize that would collapse the painted shape", () => {
  const rectangle: BoardNode = {
    ...note("rectangle", 0, 0, 100, 100),
    data: {
      kind: "shape",
      title: "Rectangle",
      shape: { type: "rectangle", strokeWidth: 12 },
    },
  };
  const base = board(rectangle);
  expect(() =>
    applyBoardSpatial(
      ops,
      request(base, { type: "resize", id: "rectangle", width: 1, height: 1 }),
    ),
  ).toThrow(expect.objectContaining({ code: "BOARD_SHAPE_TOO_SMALL" }));
  expect(ops.board(base.id)).toEqual(base);
});

it("resizes a legacy shape without rewriting an omitted undersized dimension", () => {
  const rectangle: BoardNode = {
    ...note("rectangle", 0, 0, 20, 100),
    data: {
      kind: "shape",
      title: "Rectangle",
      shape: { type: "rectangle", strokeWidth: 12 },
    },
  };
  const base = board(rectangle);
  const receipt = applyBoardSpatial(
    ops,
    request(base, { type: "resize", id: "rectangle", height: 40 }),
  );
  expect(receipt.changed).toEqual([
    expect.objectContaining({ width: 20, height: 40 }),
  ]);
});

it("rolls back the batch if equal gaps would reverse the painted node order", () => {
  const base = board(
    note("first", 0, 0, 100, 80),
    note("middle", 10, 0, 140, 80),
    note("last", 20, 0, 100, 80),
    note("unrelated", 400, 0, 100, 80),
  );
  const move = { type: "move", nodeIds: ["unrelated"], dx: 20, dy: 0 };
  const input = request(base, move, {
    type: "distribute",
    axis: "x",
    nodeIds: ["last", "first", "middle"],
  });
  expect(() => applyBoardSpatial(ops, input)).toThrow(
    expect.objectContaining({ code: "BOARD_DISTRIBUTION_SPAN" }),
  );
  expect(ops.board(base.id)).toEqual(base);

  const retry = applyBoardSpatial(ops, { ...input, operations: [move] });
  expect(retry.changed).toEqual([
    expect.objectContaining({ id: "unrelated", position: { x: 420, y: 0 } }),
  ]);
});

it("allows equal overlapping gaps when the painted node order is preserved", () => {
  const base = board(
    note("first", 0, 0, 100, 80),
    note("middle", 70, 0, 100, 80),
    note("last", 100, 0, 100, 80),
  );
  const receipt = applyBoardSpatial(
    ops,
    request(base, {
      type: "distribute",
      axis: "x",
      nodeIds: ["middle", "last", "first"],
    }),
  );
  expect(receipt.changed).toEqual([
    expect.objectContaining({ id: "middle", position: { x: 50, y: 0 } }),
  ]);
});

it("requires fixing a legacy dimension that has collapsed below its stroke width", () => {
  const rectangle: BoardNode = {
    ...note("rectangle", 0, 0, 1, 100),
    data: {
      kind: "shape",
      title: "Rectangle",
      shape: { type: "rectangle", strokeWidth: 12 },
    },
  };
  const base = board(rectangle);
  expect(() =>
    applyBoardSpatial(
      ops,
      request(base, { type: "resize", id: "rectangle", height: 80 }),
    ),
  ).toThrow(expect.objectContaining({ code: "BOARD_SHAPE_TOO_SMALL" }));
  expect(ops.board(base.id)).toEqual(base);
});
