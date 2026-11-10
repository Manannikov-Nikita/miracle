import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Database, migrate, retention } from "../src/server/db.js";
import { ProjectStore } from "../src/server/project-store.js";
import { SecretBox } from "../src/server/secrets.js";
import { WorkspaceOperations } from "../src/server/workspace-operations.js";
import { removeDatasetSchema } from "./helpers/legacy-workspace.js";
import type {
  BoardNode,
  Cell,
  Column,
  QuerySource,
} from "../src/shared/types.js";

let directory: string;
let db: Database;
let store: ProjectStore;
let operations: WorkspaceOperations;
const source: QuerySource = {
  connectionId: randomUUID(),
  sql: "select amount",
};
const columns: Column[] = [{ id: "amount", name: "amount", type: "Int64" }];

function open() {
  db = new Database(directory);
  migrate(db, () => {});
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32)), {
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
    projectRoot: directory,
    dataDir: directory,
  });
  operations = new WorkspaceOperations(store, async () => {});
}

function close() {
  store.close();
  db.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "miracle-datasets-"));
  open();
});
afterEach(() => {
  close();
  rmSync(directory, { recursive: true, force: true });
});

function saveResult({
  resultColumns = columns,
  query = source,
  rows = [["9007199254740993"]],
}: { resultColumns?: Column[]; query?: QuerySource; rows?: Cell[][] } = {}) {
  const id = randomUUID();
  db.query(
    "INSERT INTO result_sets(id,columns,row_count,byte_count,source,created_at) VALUES(?1,?2,?3,?4,?5,'2000-01-01T00:00:00.000Z')",
    [
      id,
      resultColumns,
      rows.length,
      Buffer.byteLength(JSON.stringify(rows)),
      query,
    ],
  );
  for (let index = 0; index < rows.length; index += 500)
    db.query(
      "INSERT INTO result_chunks(result_set_id,chunk_index,rows) VALUES(?1,?2,?3)",
      [id, index / 500, rows.slice(index, index + 500)],
    );
  return id;
}

function resultNode(
  resultSetId: string,
  data: Partial<BoardNode["data"]> = {},
): BoardNode {
  return {
    id: randomUUID(),
    type: "artifact",
    position: { x: 0, y: 0 },
    data: {
      title: "Monthly Sales",
      kind: "result",
      resultSetId,
      source,
      ...data,
    },
  };
}

function boardInput(...nodes: BoardNode[]) {
  return { name: "Board", document: { schemaVersion: 1, nodes, edges: [] } };
}

it("registers a flagged result only once across board mutations and reuses the dataset across nodes", () => {
  const resultSetId = saveResult();
  const input = {
    ...boardInput(resultNode(resultSetId, { publishDataset: true })),
    mutationId: randomUUID(),
  };
  const board = operations.createBoard(input);
  expect(board.document.nodes[0].data).toMatchObject({
    datasetName: "monthly_sales",
    datasetRevision: 1,
  });
  expect(board.document.nodes[0].data).not.toHaveProperty("publishDataset");
  expect(operations.createBoard(input)).toEqual(board);
  const second = operations.createBoard(
    boardInput(resultNode(resultSetId, { publishDataset: true })),
  );
  expect(second.document.nodes[0].data.datasetId).toBe(
    board.document.nodes[0].data.datasetId,
  );
  expect(operations.listDatasets()).toHaveLength(1);
});

it("rolls back registration if the enclosing board write fails", () => {
  const result = resultNode(saveResult(), { publishDataset: true });
  const missingResult = resultNode(randomUUID());
  expect(() =>
    operations.createBoard(boardInput(result, missingResult)),
  ).toThrow("Результат блока не найден");
  expect(operations.listDatasets()).toEqual([]);
  expect(operations.boards()).toEqual([]);
});

it("keeps a dataset and its unmodified raw chunks across board deletion, restart and retention", () => {
  const resultSetId = saveResult();
  const board = operations.createBoard(
    boardInput(resultNode(resultSetId, { publishDataset: true })),
  );
  const datasetId = board.document.nodes[0].data.datasetId as string;
  operations.deleteBoard(board.id, {
    baseRevision: board.revision,
    mutationId: randomUUID(),
  });
  close();
  open();
  retention(db);
  expect(operations.dataset(datasetId)).toMatchObject({
    name: "monthly_sales",
    resultSetId,
    columns: [
      {
        id: "amount",
        name: "amount",
        sourceName: "amount",
        type: "Int64",
        duckdbType: "BIGINT",
      },
    ],
  });
  expect(
    db.query("SELECT rows FROM result_chunks WHERE result_set_id=?1", [
      resultSetId,
    ]).rows[0]?.rows,
  ).toEqual([["9007199254740993"]]);
});

it("leaves legacy result nodes unlinked until explicit registration against a board revision", () => {
  const resultSetId = saveResult();
  const node = resultNode(resultSetId);
  const board = operations.createBoard(boardInput(node));
  expect(operations.listDatasets()).toEqual([]);
  const input = {
    resultSetId,
    boardId: board.id,
    nodeId: node.id,
    baseRevision: board.revision,
    mutationId: randomUUID(),
  };
  const dataset = operations.registerDataset(input);
  expect(operations.registerDataset(input)).toEqual(dataset);
  expect(operations.board(board.id).document.nodes[0].data.datasetId).toBe(
    dataset.id,
  );
  expect(
    operations.boardAtRevision(board.id, board.revision).document.nodes[0].data
      .datasetId,
  ).toBeUndefined();
});

it("upgrades a version 8 workspace without rewriting existing boards or chunks", () => {
  const resultSetId = saveResult();
  const board = operations.createBoard(boardInput(resultNode(resultSetId)));
  removeDatasetSchema(db);
  db.sqlite.exec("PRAGMA user_version=8");
  close();
  open();
  expect(operations.listDatasets()).toEqual([]);
  expect(operations.board(board.id)).toEqual(board);
  const dataset = operations.registerDataset({ resultSetId, name: "retained" });
  expect(dataset.resultSetId).toBe(resultSetId);
  expect(
    db.query("SELECT rows FROM result_chunks WHERE result_set_id=?1", [
      resultSetId,
    ]).rows[0]?.rows,
  ).toEqual([["9007199254740993"]]);
});

it("uses case-insensitive names, supports case-only renames and rejects conflicting edits", () => {
  const dataset = operations.registerDataset({
    resultSetId: saveResult(),
    name: "Sales",
  });
  const duplicate = saveResult();
  expect(() =>
    operations.registerDataset({ resultSetId: duplicate, name: "sales" }),
  ).toThrow(expect.objectContaining({ statusCode: 409 }));
  const renamed = operations.renameDataset(dataset.id, {
    name: "SALES",
    baseRevision: 1,
  });
  expect(renamed).toMatchObject({ name: "SALES", revision: 2 });
  expect(() =>
    operations.deleteDataset(dataset.id, { baseRevision: 1 }),
  ).toThrow(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  expect(() =>
    operations.commitDatasetRefresh(dataset.id, {
      resultSetId: duplicate,
      baseRevision: 1,
    }),
  ).toThrow(expect.objectContaining({ code: "REVISION_CONFLICT" }));
});

it("preserves source column labels and maps stable DuckDB names and types", () => {
  const resultSetId = saveResult({
    resultColumns: [
      { id: "a", name: "Amount", type: "Nullable(Decimal(38, 12))" },
      { id: "b", name: "amount", type: "LowCardinality(Nullable(String))" },
      { id: "c", name: "amount_2", type: "Array(UInt64)" },
      { id: "d", name: "", type: "timestamp(6) with time zone" },
      { id: "e", name: "precise_at", type: "timestamp(12)" },
      { id: "f", name: "precise_tz", type: "timestamp(9) with time zone" },
      { id: "g", name: "precise_time", type: "time(9)" },
    ],
    rows: [],
  });
  const dataset = operations.registerDataset({ resultSetId });
  expect(
    dataset.columns.map(({ id, name, sourceName, duckdbType }) => [
      id,
      name,
      sourceName,
      duckdbType,
    ]),
  ).toEqual([
    ["a", "Amount", "Amount", "DECIMAL(38,12)"],
    ["b", "amount_3", "amount", "VARCHAR"],
    ["c", "amount_2", "amount_2", "JSON"],
    ["d", "column_4", "", "TIMESTAMP WITH TIME ZONE"],
    ["e", "precise_at", "precise_at", "VARCHAR"],
    ["f", "precise_tz", "precise_tz", "VARCHAR"],
    ["g", "precise_time", "precise_time", "VARCHAR"],
  ]);
});

it("refreshes all linked boards, accepts stale layout edits and keeps their old snapshots", () => {
  const resultSetId = saveResult();
  const dataset = operations.registerDataset({ resultSetId, name: "sales" });
  const first = operations.createBoard(
    boardInput(resultNode(resultSetId, { datasetId: dataset.id })),
  );
  const second = operations.createBoard(
    boardInput(
      resultNode(resultSetId, { datasetId: dataset.id, title: "Other title" }),
    ),
  );
  const nextSource = { ...source, sql: "select amount * 2" };
  const nextId = saveResult({ query: nextSource });
  const request = {
    resultSetId: nextId,
    baseRevision: 1,
    mutationId: randomUUID(),
  };
  const refreshed = operations.commitDatasetRefresh(dataset.id, request);
  expect(operations.commitDatasetRefresh(dataset.id, request)).toEqual(
    refreshed,
  );
  expect(refreshed).toMatchObject({
    resultSetId: nextId,
    source: nextSource,
    revision: 2,
  });
  expect(operations.board(second.id).document.nodes[0].data).toMatchObject({
    resultSetId: nextId,
    datasetRevision: 2,
    sourceRevision: 2,
    source: nextSource,
    title: "Other title",
  });
  const draft = structuredClone(first.document);
  draft.nodes[0].position.x = 500;
  const saved = operations.updateBoard(first.id, {
    baseRevision: first.revision,
    document: draft,
  });
  expect(saved.document.nodes[0]).toMatchObject({
    position: { x: 500, y: 0 },
    data: { resultSetId: nextId, datasetRevision: 2, source: nextSource },
  });
  expect(
    operations.boardAtRevision(first.id, first.revision).document.nodes[0].data
      .resultSetId,
  ).toBe(resultSetId);
  retention(db);
  expect(
    db.query("SELECT id FROM result_sets WHERE id=?1", [resultSetId]).rowCount,
  ).toBe(1);
});

it("keeps user chart settings when a refreshed snapshot exceeds the presentation limit", () => {
  const resultSetId = saveResult();
  const chart = {
    kind: "bar" as const,
    x: "amount",
    y: ["amount"],
    legend: true,
  };
  const board = operations.createBoard(
    boardInput(
      resultNode(resultSetId, { publishDataset: true, view: "chart", chart }),
    ),
  );
  const datasetId = board.document.nodes[0].data.datasetId as string;
  const nextId = saveResult({
    rows: Array.from({ length: 5001 }, (_, i) => [i]),
  });
  operations.commitDatasetRefresh(datasetId, {
    resultSetId: nextId,
    baseRevision: 1,
  });
  const refreshed = operations.board(board.id);
  expect(refreshed.document.nodes[0].data).toMatchObject({
    resultSetId: nextId,
    view: "chart",
    chart,
  });
  expect(refreshed.document.nodes[0].data.sourceRevision).toBe(2);
  expect(
    operations.updateBoard(board.id, {
      baseRevision: refreshed.revision,
      document: refreshed.document,
    }).document.nodes[0].data.chart,
  ).toEqual(chart);
  operations.deleteDataset(datasetId, { baseRevision: 2 });
  expect(operations.board(board.id).document.nodes[0].data).toMatchObject({
    resultSetId: nextId,
    view: "chart",
    chart,
  });
  expect(operations.board(board.id).document.nodes[0].data.sourceRevision).toBe(
    3,
  );
});

it("detaches deleted datasets without changing board snapshots or resurrecting stale links", () => {
  const resultSetId = saveResult();
  const board = operations.createBoard(
    boardInput(resultNode(resultSetId, { publishDataset: true })),
  );
  const datasetId = board.document.nodes[0].data.datasetId as string;
  const request = { baseRevision: 1, mutationId: randomUUID() };
  expect(operations.deleteDataset(datasetId, request)).toEqual({ ok: true });
  expect(operations.deleteDataset(datasetId, request)).toEqual({ ok: true });
  expect(operations.listDatasets()).toEqual([]);
  const draft = structuredClone(board.document);
  draft.nodes[0].data.title = "New title";
  const saved = operations.updateBoard(board.id, {
    baseRevision: board.revision,
    document: draft,
  });
  expect(saved.document.nodes[0].data).toMatchObject({
    resultSetId,
    title: "New title",
  });
  expect(saved.document.nodes[0].data.datasetId).toBeUndefined();
  retention(db);
  expect(
    db.query("SELECT id FROM result_sets WHERE id=?1", [resultSetId]).rowCount,
  ).toBe(1);
});

it("holds each reader's pinned version through refresh and releases it for retention", () => {
  const oldId = saveResult();
  const dataset = operations.registerDataset({ resultSetId: oldId });
  const first = operations.pinDatasets();
  const second = operations.pinDatasets();
  const currentId = saveResult();
  operations.commitDatasetRefresh(dataset.id, {
    resultSetId: currentId,
    baseRevision: 1,
  });
  expect(first.datasets[0].resultSetId).toBe(oldId);
  first.release();
  first.release();
  retention(db);
  expect(
    db.query("SELECT id FROM result_sets WHERE id=?1", [oldId]).rowCount,
  ).toBe(1);
  second.release();
  retention(db);
  expect(
    db.query("SELECT id FROM result_sets WHERE id=?1", [oldId]).rowCount,
  ).toBe(0);
  expect(
    db.query("SELECT id FROM result_sets WHERE id=?1", [currentId]).rowCount,
  ).toBe(1);
});

it("rolls back an invalid refresh together with the new run result", () => {
  const resultSetId = saveResult();
  const board = operations.createBoard(
    boardInput(resultNode(resultSetId, { publishDataset: true })),
  );
  const datasetId = board.document.nodes[0].data.datasetId as string;
  const renamed = operations.renameDataset(datasetId, {
    baseRevision: 1,
    name: "sales",
  });
  const currentBoard = operations.board(board.id);
  const eventCount = store.since(0).length;
  expect(() =>
    db.transaction(() => {
      const nextId = saveResult();
      operations.commitDatasetRefresh(datasetId, {
        baseRevision: 1,
        resultSetId: nextId,
      });
    }),
  ).toThrow(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  expect(operations.dataset(datasetId)).toEqual(renamed);
  expect(operations.board(board.id)).toEqual(currentBoard);
  expect(store.since(0)).toHaveLength(eventCount);
  expect(db.query("SELECT id FROM result_sets").rows).toEqual([
    { id: resultSetId },
  ]);
});

it("releases obsolete result versions when the process restarts", () => {
  const resultSetId = saveResult();
  const dataset = operations.registerDataset({ resultSetId });
  const { release } = operations.pinDatasets();
  const currentId = saveResult();
  operations.commitDatasetRefresh(dataset.id, {
    resultSetId: currentId,
    baseRevision: 1,
  });
  close();
  open();
  retention(db);
  expect(db.query("SELECT id FROM result_sets").rows).toEqual([
    { id: currentId },
  ]);
  release();
});

it("ignores stale snapshot fields from clients that omit the canonical binding", () => {
  const resultSetId = saveResult();
  const board = operations.createBoard(
    boardInput(resultNode(resultSetId, { publishDataset: true })),
  );
  const datasetId = board.document.nodes[0].data.datasetId as string;
  const currentId = saveResult();
  operations.commitDatasetRefresh(datasetId, {
    resultSetId: currentId,
    baseRevision: 1,
  });
  const draft = structuredClone(board.document);
  delete draft.nodes[0].data.datasetId;
  draft.nodes[0].data.title = "Revised title";
  const saved = operations.updateBoard(board.id, {
    baseRevision: board.revision,
    document: draft,
  });
  expect(saved.document.nodes[0].data).toMatchObject({
    datasetId,
    datasetRevision: 2,
    resultSetId: currentId,
    title: "Revised title",
  });
});

it("removes the dataset binding when a result block becomes a note", () => {
  const resultSetId = saveResult();
  const board = operations.createBoard(
    boardInput(resultNode(resultSetId, { publishDataset: true })),
  );
  const draft = structuredClone(board.document);
  draft.nodes[0].data.kind = "note";
  const saved = operations.updateBoard(board.id, {
    baseRevision: board.revision,
    document: draft,
  });
  expect(saved.document.nodes[0].data.datasetId).toBeUndefined();
  expect(operations.listDatasets()).toHaveLength(1);
});

it("follows saved local query edits in a clean linked editor and keeps a divergent draft", async () => {
  const saved = await operations.saveQuery({
    name: "Local",
    kind: "local",
    sql: "SELECT 1",
  });
  const createEditor = (sql: string) =>
    store.createEditor({
      name: saved.name,
      kind: "local",
      sql,
      queryId: saved.id,
      queryRevision: saved.revision,
    });
  const clean = createEditor("SELECT 1");
  const draft = createEditor("SELECT 99");
  const updated = await operations.saveQuery(
    {
      name: "Local revised",
      kind: "local",
      sql: "SELECT 2",
      baseRevision: saved.revision,
    },
    saved.id,
  );
  expect(store.editor(clean.id)).toMatchObject({
    kind: "local",
    name: "Local revised",
    sql: "SELECT 2",
    queryRevision: 2,
  });
  expect(store.editor(draft.id)).toEqual(draft);
  await operations.saveQuery(
    {
      ...source,
      name: "Remote now",
      baseRevision: updated.revision,
    },
    saved.id,
  );
  expect(store.editor(clean.id)).toMatchObject({
    kind: "remote",
    connectionId: source.connectionId,
    sql: source.sql,
    queryRevision: 3,
  });
});

it("restores a removed chart as a historical snapshot after its dataset is deleted", () => {
  const chart = {
    kind: "bar" as const,
    x: "amount",
    y: ["amount"],
    legend: true,
  };
  const board = operations.createBoard(
    boardInput(
      resultNode(saveResult(), {
        publishDataset: true,
        view: "chart",
        chart,
      }),
    ),
  );
  const datasetId = board.document.nodes[0].data.datasetId!;
  const refreshedResult = saveResult({
    query: { ...source, sql: "SELECT refreshed_amount" },
    rows: Array.from({ length: 5001 }, (_, i) => [i]),
  });
  operations.commitDatasetRefresh(datasetId, {
    baseRevision: 1,
    resultSetId: refreshedResult,
  });
  const history = operations.board(board.id);
  const removed = operations.updateBoard(board.id, {
    baseRevision: history.revision,
    document: { ...history.document, nodes: [] },
  });
  operations.deleteDataset(datasetId, { baseRevision: 2 });
  retention(db);
  const forged = structuredClone(history.document);
  forged.nodes[0].id = randomUUID();
  expect(() =>
    operations.updateBoard(board.id, {
      baseRevision: removed.revision,
      document: forged,
    }),
  ).toThrow(expect.objectContaining({ code: "DATASET_NOT_FOUND" }));
  expect(() =>
    operations.createBoard({
      name: "Different board",
      document: history.document,
    }),
  ).toThrow(expect.objectContaining({ code: "DATASET_NOT_FOUND" }));

  const restore = structuredClone(history.document);
  restore.nodes[0].data.source = { ...source, sql: "SELECT stale_override" };
  const restored = operations.updateBoard(board.id, {
    baseRevision: removed.revision,
    document: restore,
  });
  expect(restored.document.nodes[0].data).toMatchObject({
    resultSetId: refreshedResult,
    source: { ...source, sql: "SELECT refreshed_amount" },
    view: "chart",
    chart,
  });
  expect(restored.document.nodes[0].data.datasetId).toBeUndefined();
  expect(operations.listDatasets()).toEqual([]);
});

it.each(["live", "deleted"])(
  "restores a result converted into a note with a %s dataset",
  (state) => {
    const resultSetId = saveResult();
    const board = operations.createBoard(
      boardInput(resultNode(resultSetId, { publishDataset: true })),
    );
    const original = board.document.nodes[0].data;
    const draft = structuredClone(board.document);
    draft.nodes[0].data.kind = "note";
    const note = operations.updateBoard(board.id, {
      baseRevision: board.revision,
      document: draft,
    });
    if (state === "deleted")
      operations.deleteDataset(original.datasetId!, { baseRevision: 1 });
    const restored = operations.updateBoard(board.id, {
      baseRevision: note.revision,
      document: board.document,
    }).document.nodes[0].data;
    expect(restored).toMatchObject({ kind: "result", resultSetId });
    expect(restored.datasetId).toBe(
      state === "live" ? original.datasetId : undefined,
    );
    expect(restored.sourceRevision).toBeGreaterThan(
      note.document.nodes[0].data.sourceRevision!,
    );
  },
);
