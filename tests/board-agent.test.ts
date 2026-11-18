import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as boardAgent from "../src/server/board-agent";
import { Database, migrate } from "../src/server/db";
import { ProjectStore } from "../src/server/project-store";
import { SecretBox } from "../src/server/secrets";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import type { BoardNode } from "../src/shared/types";
import { createEmptyVisualTable } from "../src/shared/visual-table";

let root: string, db: Database, store: ProjectStore, ops: WorkspaceOperations;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miracle-board-agent-"));
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

function note(id: string, x: number, y: number, text?: string): BoardNode {
  return {
    id,
    type: "artifact",
    position: { x, y },
    width: 100,
    height: 80,
    data: { kind: "note", title: id, text },
  };
}

it("reports painted geometry, focused gaps and incident links without exposing node payloads", () => {
  const arrow: BoardNode = {
    ...note("arrow", 10, 100),
    width: 260,
    height: 40,
    data: {
      kind: "shape",
      title: "Arrow",
      shape: { type: "line", lineEnd: "arrow", rotation: 90 },
      text: "secret full text",
    },
  };
  const board = ops.createBoard({
    name: "Board",
    document: {
      schemaVersion: 1,
      nodes: [arrow, note("card", 195, 90, "secret card text")],
      edges: [
        {
          id: "link",
          source: "card",
          targetPoint: { x: 500, y: 64 },
          sourceHandle: "right",
        },
      ],
    },
  });
  const result = boardAgent.readBoardScene(ops, {
    id: board.id,
    nodeIds: ["arrow", "card"],
  });
  expect(result.items).toEqual([
    expect.objectContaining({
      type: "node",
      id: "arrow",
      rotation: 90,
      bounds: {
        x: expect.closeTo(136.4),
        y: expect.closeTo(-4.4),
        right: expect.closeTo(143.6),
        bottom: expect.closeTo(244.4),
      },
      line: expect.objectContaining({
        start: { x: 140, y: expect.closeTo(-4.4) },
        end: { x: 140, y: expect.closeTo(244.4) },
      }),
    }),
    expect.objectContaining({
      type: "node",
      id: "card",
      relations: [
        expect.objectContaining({
          nodeId: "arrow",
          x: "right",
          y: "overlap",
          gapX: expect.closeTo(51.4),
        }),
      ],
    }),
    expect.objectContaining({
      type: "edge",
      id: "link",
      source: expect.objectContaining({ nodeId: "card", handle: "right" }),
      target: { point: { x: 500, y: 64 } },
    }),
  ]);
  expect(JSON.stringify(result)).not.toMatch(/secret|customChart|resultSetId/);
});

it("reads scene continuation from its pinned revision after a board update", () => {
  const board = ops.createBoard({
    name: "Board",
    document: {
      schemaVersion: 1,
      nodes: [note("a", 0, 0), note("b", 25, 0)],
      edges: [],
    },
  });
  const first = boardAgent.readBoardScene(ops, { id: board.id, limit: 1 });
  expect(first.items.map(({ id }) => id)).toEqual(["a"]);
  expect(first.nextOffset).toBe(1);
  ops.patchBoard(board.id, {
    baseRevision: board.revision,
    mutationId: randomUUID(),
    operations: [{ type: "remove_node", id: "b" }],
  });
  expect(() =>
    boardAgent.readBoardScene(ops, { id: board.id, offset: 1 }),
  ).toThrow();
  const next = boardAgent.readBoardScene(ops, {
    id: board.id,
    revision: first.revision,
    offset: first.nextOffset,
    limit: 1,
  });
  expect(next.items.map(({ id }) => id)).toEqual(["b"]);
  expect(next.revision).toBe(first.revision);
  expect(next.nextOffset).toBeNull();
});

it("keeps separate slide coordinate spaces and rejects ID mismatches", () => {
  const board = ops.createBoard({
    name: "Presentation",
    document: {
      schemaVersion: 1,
      kind: "presentation",
      slides: [
        { id: "first", title: "First", background: "#ffffff" },
        { id: "second", title: "Second", background: "#ffffff" },
      ],
      nodes: [
        { ...note("a", 0, 0), slideId: "first" },
        { ...note("b", 0, 0), slideId: "second" },
      ],
      edges: [],
    },
  });
  const result = boardAgent.readBoardScene(ops, {
    id: board.id,
    slideId: "first",
    nodeIds: ["a"],
  });
  expect(result.items).toEqual([
    expect.objectContaining({ type: "node", id: "a", slideId: "first" }),
  ]);
  expect(() =>
    boardAgent.readBoardScene(ops, {
      id: board.id,
      slideId: "first",
      nodeIds: ["b"],
    }),
  ).toThrow();
});

it("pages a large exact selected payload without exceeding the UTF-8 budget or including unselected objects", () => {
  const text = '\\"🐈🧪\n'.repeat(12500);
  const board = ops.createBoard({
    name: "Board",
    document: {
      schemaVersion: 1,
      nodes: [note("a", 0, 0, text), note("b", 0, 0, "unselected content")],
      edges: [{ id: "e", source: "a", target: "b" }],
    },
  });
  let offset = 0;
  let json = "";
  for (;;) {
    const part = boardAgent.readBoardItems(ops, {
      id: board.id,
      nodeIds: ["a"],
      edgeIds: ["e"],
      revision: board.revision,
      offset,
      limit: 48 * 1024,
    });
    expect(part.offset).toBe(offset);
    expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(
      48 * 1024,
    );
    // JSON response text is itself JSON escaped by the MCP transport.
    expect(
      Buffer.byteLength(JSON.stringify(JSON.stringify(part))),
    ).toBeLessThanOrEqual(48 * 1024);
    expect(part.jsonChunk).not.toMatch(/[\uD800-\uDBFF]$/u);
    json += part.jsonChunk;
    if (part.nextOffset === null) break;
    expect(part.nextOffset).toBeGreaterThan(offset);
    offset = part.nextOffset;
  }
  expect(json).toBe(
    JSON.stringify({
      nodes: [board.document.nodes[0]],
      edges: [board.document.edges[0]],
    }),
  );
  expect(() => boardAgent.readBoardItems(ops, { id: board.id })).toThrow();
});

it("keeps a dense scene within its serialized budget while producing a continuation", () => {
  const nodes = Array.from({ length: 100 }, (_, index) =>
    note(
      `"${index}` + "\\🎯".repeat(60),
      index * 101,
      0,
      "dense preview ".repeat(1000),
    ),
  );
  const board = ops.createBoard({
    name: "Board",
    document: { schemaVersion: 1, nodes, edges: [] },
  });
  const scene = boardAgent.readBoardScene(ops, {
    id: board.id,
    nodeIds: nodes.slice(0, 12).map(({ id }) => id),
    includeTextPreview: true,
    limit: 100,
  });
  expect(scene.items.length).toBeGreaterThan(0);
  expect(
    Buffer.byteLength(JSON.stringify(JSON.stringify(scene))),
  ).toBeLessThanOrEqual(48 * 1024);
  const all = boardAgent.readBoardScene(ops, {
    id: board.id,
    includeTextPreview: true,
    limit: 100,
  });
  expect(all.nextOffset).toBeGreaterThan(0);
  expect(all.items.length).toBeLessThan(100);
  expect(
    Buffer.byteLength(JSON.stringify(JSON.stringify(all))),
  ).toBeLessThanOrEqual(48 * 1024);
});

it("omits stored SQL and local table rows even when the scene includes text previews", () => {
  const source = { connectionId: randomUUID(), sql: "SELECT 'private SQL'" };
  const resultSetId = randomUUID();
  db.query(
    "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,?3,?4,?5)",
    [resultSetId, [], 0, 0, source],
  );
  const board = ops.createBoard({
    name: "Board",
    document: {
      schemaVersion: 1,
      nodes: [
        {
          ...note("result", 0, 0),
          data: { kind: "result", title: "Result", source, resultSetId },
        },
        {
          ...note("table", 20, 0),
          data: {
            kind: "table",
            title: "Table",
            visualTable: createEmptyVisualTable(),
          },
        },
        note("text", 40, 0, "A".repeat(400)),
      ],
      edges: [],
    },
  });
  const scene = boardAgent.readBoardScene(ops, {
    id: board.id,
    includeTextPreview: true,
  });
  expect(scene.items).toEqual([
    expect.objectContaining({ kind: "result", title: "Result" }),
    expect.objectContaining({ kind: "table", title: "Table" }),
    expect.objectContaining({ kind: "note", textPreview: "A".repeat(120) }),
  ]);
  expect(JSON.stringify(scene)).not.toMatch(
    /private SQL|resultSetId|visualTable|rows|columns/,
  );
});

function resultForChartSizing(): BoardNode {
  const resultSetId = randomUUID();
  const source = { connectionId: randomUUID(), sql: "SELECT 1" };
  db.query(
    "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,?3,?4,?5)",
    [resultSetId, [], 0, 0, source],
  );
  return {
    id: "result",
    type: "artifact",
    position: { x: 50, y: 30 },
    data: {
      kind: "result",
      title: "Результат",
      resultSetId,
      source,
      view: "chart",
    },
  };
}

it("accepts full histogram sources and retains the point limit on unaggregated charts", () => {
  const node = resultForChartSizing();
  const resultId = node.data.resultSetId!;
  const chart = {
    kind: "histogram",
    x: "elapsed",
    y: [],
    binCount: 12,
    legend: true,
  } as const;
  const save = (kind: "histogram" | "line") =>
    ops.createBoard({
      name: "Duration",
      document: {
        schemaVersion: 1,
        edges: [],
        nodes: [{ ...node, data: { ...node.data, chart: { ...chart, kind } } }],
      },
    });
  db.query("UPDATE result_sets SET columns=?2, row_count=50000 WHERE id=?1", [
    resultId,
    [{ id: "elapsed", name: "Duration", type: "Float64" }],
  ]);
  expect(save("histogram").document.nodes[0].data.chart).toEqual(chart);
  expect(() => save("line")).toThrow(/5000 точек/);
  db.query("UPDATE result_sets SET row_count=50001 WHERE id=?1", [resultId]);
  expect(() => save("histogram")).toThrow(/50 000 строк/);
});

it("sizes newly created and agent-added charts on each missing side, preserving supplied frames and idempotent responses", () => {
  const node = resultForChartSizing();
  const request = {
    name: "Dashboard",
    mutationId: randomUUID(),
    document: {
      schemaVersion: 1,
      nodes: [
        node,
        { ...node, id: "width", width: 777 },
        { ...node, id: "sized", width: 380, height: 220 },
      ],
      edges: [],
    },
  };
  const created = ops.createBoard(request);
  expect(created.document.nodes.map((n) => [n.width, n.height])).toEqual([
    [702, 455],
    [777, 455],
    [380, 220],
  ]);
  expect(ops.createBoard(request)).toEqual(created);
  const patch = {
    baseRevision: created.revision,
    mutationId: randomUUID(),
    operations: [
      { type: "add_node", node: { ...node, id: "height", height: 250 } },
    ],
  };
  const added = ops.patchBoard(created.id, patch);
  expect(added.document.nodes.at(-1)).toMatchObject({
    width: 702,
    height: 250,
  });
  expect(ops.patchBoard(created.id, patch)).toEqual(added);
});

it("grows only first chart conversions of default tables and preserves full-snapshot undo and implicit legacy geometry", () => {
  const source = resultForChartSizing();
  const table = {
    ...source,
    width: 540,
    height: 350,
    data: { ...source.data, view: "table" as const },
  };
  const configured = { kind: "bar" as const, x: "x", y: ["y"], legend: true };
  const original = ops.createBoard({
    name: "Board",
    document: {
      schemaVersion: 1,
      edges: [],
      nodes: [
        table,
        { ...table, id: "manual", width: 415 },
        {
          ...table,
          id: "configured",
          data: { ...table.data, chart: configured },
        },
        { ...table, id: "explicit" },
      ],
    },
  });
  const operations = original.document.nodes.map((n) => ({
    type: "update_node",
    id: n.id,
    patch: {
      data: { view: "chart", chart: configured },
      ...(n.id === "explicit" ? { height: 200 } : {}),
    },
  }));
  const saved = ops.patchBoard(original.id, {
    baseRevision: original.revision,
    mutationId: randomUUID(),
    operations,
  });
  expect(saved.document.nodes.map((n) => [n.width, n.height])).toEqual([
    [702, 455],
    [415, 350],
    [540, 350],
    [540, 200],
  ]);
  const undone = ops.updateBoard(original.id, {
    baseRevision: saved.revision,
    document: original.document,
  });
  expect(undone.document).toEqual(original.document);
  const oldDocument = {
    ...undone.document,
    nodes: [{ ...source, id: "legacy" }],
  };
  const restored = ops.updateBoard(original.id, {
    baseRevision: undone.revision,
    document: oldDocument,
  });
  expect(restored.document).toEqual(oldDocument);
  const renamed = ops.patchBoard(original.id, {
    baseRevision: restored.revision,
    mutationId: randomUUID(),
    operations: [
      {
        type: "update_node",
        id: "legacy",
        patch: { data: { title: "Новое имя" } },
      },
    ],
  });
  expect(renamed.document.nodes[0].width).toBeUndefined();
  expect(renamed.document.nodes[0].height).toBeUndefined();
});
