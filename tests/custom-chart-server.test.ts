import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Database } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import { buildApp } from "../src/server/app";
import {
  serializeCustomChart,
  type CustomChartSpec,
} from "../src/shared/custom-charts";
import { createTableSpec } from "../src/client/board/tableModel";
import type { Column, Cell } from "../src/shared/types";

let directory: string,
  db: Database,
  store: ProjectStore,
  operations: WorkspaceOperations;
let app: Awaited<ReturnType<typeof buildApp>>;
const source = { sql: "SELECT secret", connectionId: randomUUID() };
const spec: CustomChartSpec = {
  version: 1,
  description: "Example",
  html: "<svg></svg>",
  css: "svg {width:100%}",
  javascript: "api.root.title = String(api.rows.length)",
};
function snapshot(
  rowCount = 1,
  columnCount = 1,
  rows: unknown[][] = [["9007199254740993"]],
) {
  const id = randomUUID();
  const columns = Array.from({ length: columnCount }, (_, i) => ({
    id: `c${i}`,
    name: `value${i}`,
    type: "String",
  }));
  db.query(
    "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,?3,?4,?5)",
    [id, columns, rowCount, 1, source],
  );
  for (let i = 0; i * 500 < rows.length; i++)
    db.query(
      "INSERT INTO result_chunks(result_set_id,chunk_index,rows) VALUES(?1,?2,?3)",
      [id, i, rows.slice(i * 500, (i + 1) * 500)],
    );
  return id;
}
const node = (resultSetId: string, id = "chart", chart = spec) => ({
  id,
  type: "artifact",
  position: { x: 0, y: 0 },
  data: {
    title: "Example",
    kind: "result",
    view: "custom",
    resultSetId,
    source,
    customChart: chart,
  },
});
const document = (nodes: unknown[]) => ({ schemaVersion: 1, nodes, edges: [] });
function tableSnapshot(columns: Column[], rows: Cell[][]) {
  const id = snapshot(rows.length, columns.length, rows);
  db.query("UPDATE result_sets SET columns=?2 WHERE id=?1", [id, columns]);
  return id;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "miracle-custom-server-"));
  app = await buildApp({
    dataDir: directory,
    serveStatic: false,
    appOrigin: "http://127.0.0.1:5178",
  });
  db = app.miracle.db;
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: directory,
    dataDir: directory,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  operations = new WorkspaceOperations(store, async () => {});
});
afterEach(async () => {
  store.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

it("preserves custom source through saves, mode switching, copy, conflict and deduplicated retry", () => {
  const created = operations.createBoard({
    name: "Custom",
    document: document([node(snapshot())]),
  });
  const input = {
    baseRevision: created.revision,
    mutationId: randomUUID(),
    operations: [
      { type: "update_node", id: "chart", patch: { data: { view: "table" } } },
    ],
  };
  const saved = operations.patchBoard(created.id, input);
  expect(operations.patchBoard(created.id, input)).toEqual(saved);
  expect(saved.document.nodes[0].data.customChart).toEqual(spec);
  // Repeating an already-applied value is compatible with independent writers.
  expect(
    operations.patchBoard(created.id, { ...input, mutationId: randomUUID() })
      .document,
  ).toEqual(saved.document);
  expect(() =>
    operations.patchBoard(created.id, {
      ...input,
      mutationId: randomUUID(),
      operations: [
        {
          type: "update_node",
          id: "chart",
          patch: { data: { title: "Competing edit" } },
        },
      ],
    }),
  ).toThrow(/измен/);
  const copy = operations.createBoard({
    name: "Copy",
    document: operations.board(created.id).document,
  });
  expect(copy.document.nodes[0].data.customChart).toEqual(spec);
});

it.each([
  [5001, 1],
  [5000, 21],
])(
  "rejects custom attachments from metadata with %i rows and %i columns atomically",
  (rowCount, columns) => {
    const before = operations.createBoard({ name: "Empty" });
    const id = snapshot(rowCount, columns);
    expect(() =>
      operations.patchBoard(before.id, {
        baseRevision: before.revision,
        mutationId: randomUUID(),
        operations: [{ type: "add_node", node: node(id) }],
      }),
    ).toThrow(/Агрегируйте|агрегируйте/);
    expect(operations.board(before.id)).toEqual(before);
    expect(db.query("SELECT * FROM board_result_refs").rows).toEqual([]);
  },
);

it("rejects aggregate board growth atomically, including custom specs hidden in table mode", async () => {
  const id = snapshot();
  const large = {
    ...spec,
    html: "x".repeat(90000),
    css: "x".repeat(90000),
    javascript: "x".repeat(70000),
  };
  let board = operations.createBoard({
    name: "Boundary",
    document: document([node(id, "0", large)]),
  });
  for (let i = 1; i < 6; i++)
    board = operations.patchBoard(board.id, {
      baseRevision: board.revision,
      mutationId: randomUUID(),
      operations: [{ type: "add_node", node: node(id, String(i), large) }],
    });
  const before = board;
  const oversized = document([
    ...before.document.nodes,
    {
      ...node(id, "7", large),
      data: { ...node(id, "7", large).data, view: "table" },
    },
  ]);
  const countEvents = db.query("SELECT count(*) n FROM project_events").rows[0]
    .n;
  for (const run of [
    () =>
      operations.patchBoard(board.id, {
        baseRevision: board.revision,
        mutationId: randomUUID(),
        operations: [{ type: "add_node", node: node(id, "7", large) }],
      }),
    () =>
      operations.updateBoard(board.id, {
        baseRevision: board.revision,
        document: oversized,
      }),
    () =>
      operations.createBoard({ name: "Oversized copy", document: oversized }),
  ])
    expect(run).toThrow(expect.objectContaining({ code: "BOARD_TOO_LARGE" }));
  expect(operations.board(board.id)).toEqual(before);
  expect(operations.boards()).toHaveLength(1);
  expect(db.query("SELECT count(*) n FROM project_events").rows[0].n).toBe(
    countEvents,
  );
  const saved = operations.updateBoard(board.id, {
    name: "Renamed",
    baseRevision: board.revision,
    document: board.document,
  });
  expect(saved.name).toBe("Renamed");
  expect(
    operations.createBoard({ name: "Boundary copy", document: saved.document })
      .document,
  ).toEqual(saved.document);
  const { app, headers } = await api();
  const response = await app.inject({
    method: "PATCH",
    url: `/api/boards/${saved.id}`,
    headers,
    payload: {
      name: "Browser save",
      baseRevision: saved.revision,
      document: saved.document,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const copy = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers,
    payload: { name: "Browser copy", document: response.json().document },
  });
  expect(copy.statusCode, copy.body).toBe(201);
  expect(copy.json().document).toEqual(saved.document);
});

it("validates current source and snapshot for reports without mutating the board", () => {
  const board = operations.createBoard({
    name: "Custom",
    document: document([node(snapshot())]),
  });
  const report = {
    browserId: randomUUID(),
    sequence: 1,
    sentAt: Date.now(),
    resultSetId: board.document.nodes[0].data.resultSetId,
    specHash: createHash("sha256")
      .update(serializeCustomChart(spec))
      .digest("hex"),
    status: "rendered",
  };
  expect(operations.customChartStatus(board.id, "chart")).toEqual({
    status: "not_observed",
    reports: [],
  });
  expect(operations.reportCustomChartStatus(board.id, "chart", report)).toEqual(
    { ok: true },
  );
  expect(operations.customChartStatus(board.id, "chart").status).toBe(
    "rendered",
  );
  expect(operations.board(board.id)).toEqual(board);
  const changed = operations.patchBoard(board.id, {
    baseRevision: board.revision,
    mutationId: randomUUID(),
    operations: [
      {
        type: "update_node",
        id: "chart",
        patch: {
          data: {
            customChart: { ...spec, javascript: "throw Error('changed')" },
          },
        },
      },
    ],
  });
  expect(operations.customChartStatus(board.id, "chart").status).toBe(
    "not_observed",
  );
  expect(() =>
    operations.reportCustomChartStatus(board.id, "chart", {
      ...report,
      sequence: 2,
    }),
  ).toThrow(/измен/);
  expect(operations.board(board.id)).toEqual(changed);
});

async function api() {
  const session = await app.inject({
    url: "/api/session",
    headers: { host: "127.0.0.1:5178" },
  });
  const headers = {
    host: "127.0.0.1:5178",
    origin: "http://127.0.0.1:5178",
    cookie: String(session.headers["set-cookie"]).split(";")[0],
    "x-csrf-token": session.json().csrfToken,
  };
  return { app, headers };
}

it("serves only columns and exact uncoerced rows through the authenticated bounded data route", async () => {
  const id = snapshot(1, 1, [["9007199254740993", "</script>"]]);
  const { app, headers } = await api();
  const denied = await app.inject({
    url: `/api/result-sets/${id}/custom-chart`,
    headers: { host: headers.host },
  });
  expect(denied.statusCode).toBe(401);
  const response = await app.inject({
    url: `/api/result-sets/${id}/custom-chart`,
    headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({
    columns: [{ id: "c0", name: "value0", type: "String" }],
    rows: [["9007199254740993", "</script>"]],
  });
  const empty = snapshot(0, 1, []);
  expect(
    (
      await app.inject({
        url: `/api/result-sets/${empty}/custom-chart`,
        headers,
      })
    ).json().rows,
  ).toEqual([]);
});

it("rejects exact serialized byte overflow, actual cell overflow and incomplete snapshots without truncation", async () => {
  const ids = [
    snapshot(5001, 1),
    snapshot(5000, 21),
    snapshot(1, 1, [["я".repeat(2700000)]]),
    snapshot(1, 1, [Array.from({ length: 100001 }, () => 0)]),
    snapshot(2, 1, [[1]]),
  ];
  const { app, headers } = await api();
  for (const id of ids) {
    const response = await app.inject({
      url: `/api/result-sets/${id}/custom-chart`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).not.toHaveProperty("rows");
  }
});

it("prepares custom chart rows with table filtering, melt, ordering, labels and separate display values", async () => {
  const columns: Column[] = [
    { id: "account", name: "Счёт", type: "String" },
    { id: "revenue", name: "Выручка", type: "Decimal(38, 2)" },
    { id: "cost", name: "Расход", type: "Decimal(38, 2)" },
    { id: "hidden", name: "Секрет", type: "String" },
  ];
  const id = tableSnapshot(columns, [
    ["B", "12.50", "4.00", "hidden"],
    ["A", "2", "1", "hidden"],
    ["B", "9.25", null, "hidden"],
  ]);
  const table = {
    ...createTableSpec(columns),
    filters: [{ column: "account", op: "eq", value: "B" }],
    reshape: { kind: "melt", columns: ["revenue", "cost"] },
    sort: { column: "reshape:melt:value", direction: "asc" },
    order: ["reshape:melt:value", "account", "reshape:melt:key"],
    columns: {
      hidden: { hidden: true },
      "reshape:melt:key": { label: "Метрика" },
      "reshape:melt:value": {
        label: "Сумма",
        format: "currency",
        currency: "USD",
        decimals: 2,
        thresholds: [{ value: "10", color: "red" }],
        mappings: [{ value: null, text: "Нет", color: "blue" }],
      },
    },
  };
  const { app, headers } = await api();
  const response = await app.inject({
    method: "POST",
    url: `/api/result-sets/${id}/custom-chart`,
    headers,
    payload: { table },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({
    columns: [
      { id: "reshape:melt:value", name: "Сумма", type: "Decimal(38, 2)" },
      { id: "account", name: "Счёт", type: "String" },
      { id: "reshape:melt:key", name: "Метрика", type: "String" },
    ],
    rows: [
      ["4.00", "B", "Расход"],
      ["9.25", "B", "Выручка"],
      ["12.50", "B", "Выручка"],
      [null, "B", "Расход"],
    ],
    displayRows: [
      ["$4.00", "B", "Расход"],
      ["$9.25", "B", "Выручка"],
      ["$12.50", "B", "Выручка"],
      ["Нет", "B", "Расход"],
    ],
    cellColors: [
      [null, null, null],
      [null, null, null],
      ["red", null, null],
      ["blue", null, null],
    ],
  });
});

it("applies custom chart output limits after filters and allows bounded larger source attachments", async () => {
  const columns = [{ id: "c0", name: "value0", type: "String" }];
  const id = tableSnapshot(
    columns,
    Array.from({ length: 5001 }, (_, i) => [String(i)]),
  );
  const table = {
    ...createTableSpec(columns),
    filters: [{ column: "c0", op: "eq", value: "0" }],
  };
  const custom = node(id);
  const board = operations.createBoard({
    name: "Filtered custom",
    document: document([{ ...custom, data: { ...custom.data, table } }]),
  });
  expect(board.document.nodes[0].data.table).toEqual(table);
  const { app, headers } = await api();
  const response = await app.inject({
    method: "POST",
    url: `/api/result-sets/${id}/custom-chart`,
    headers,
    payload: { table },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rows).toEqual([["0"]]);
  expect(
    (await app.inject({ url: `/api/result-sets/${id}/custom-chart`, headers }))
      .statusCode,
  ).toBe(422);
});

it("rejects custom chart expansion and ambiguous raw pivots instead of truncating or aggregating", async () => {
  const columns = [
    { id: "key", name: "Ключ", type: "String" },
    { id: "value", name: "Число", type: "Int64" },
  ];
  const id = tableSnapshot(
    columns,
    Array.from({ length: 3000 }, () => ["A", "1"]),
  );
  const { app, headers } = await api();
  for (const reshape of [
    { kind: "melt", columns: ["key", "value"] },
    { kind: "pivot", rows: [], column: "key", value: "value" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/result-sets/${id}/custom-chart`,
      headers,
      payload: { table: { ...createTableSpec(columns), reshape } },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).not.toHaveProperty("rows");
  }
});

it("invalidates custom chart diagnostics when the table presentation changes", () => {
  const board = operations.createBoard({
    name: "Custom",
    document: document([node(snapshot())]),
  });
  const report = {
    browserId: randomUUID(),
    sequence: 1,
    sentAt: Date.now(),
    resultSetId: board.document.nodes[0].data.resultSetId,
    specHash: createHash("sha256")
      .update(serializeCustomChart(spec))
      .digest("hex"),
    status: "rendered",
  };
  operations.reportCustomChartStatus(board.id, "chart", report);
  operations.patchBoard(board.id, {
    baseRevision: board.revision,
    mutationId: randomUUID(),
    operations: [
      {
        type: "update_node",
        id: "chart",
        patch: { data: { visibleColumns: [] } },
      },
    ],
  });
  expect(operations.customChartStatus(board.id, "chart").status).toBe(
    "not_observed",
  );
  expect(() =>
    operations.reportCustomChartStatus(board.id, "chart", {
      ...report,
      sequence: 2,
    }),
  ).toThrow(/измен/);
  operations.reportCustomChartStatus(board.id, "chart", {
    ...report,
    sequence: 3,
    specHash: createHash("sha256")
      .update(JSON.stringify([serializeCustomChart(spec), null, []]))
      .digest("hex"),
  });
  expect(operations.customChartStatus(board.id, "chart").status).toBe(
    "rendered",
  );
});

it("authenticates prepared chart reads and honors legacy visibility with no table configuration", async () => {
  const id = snapshot(1, 2, [["keep", "private"]]);
  const { app, headers } = await api();
  const url = `/api/result-sets/${id}/custom-chart`;
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        payload: {},
        headers: { host: headers.host },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        payload: {},
        headers: { ...headers, "x-csrf-token": "bad" },
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { visibleColumns: ["c0"] },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().columns.map((column: Column) => column.id)).toEqual([
    "c0",
  ]);
  expect(response.json().rows).toEqual([["keep"]]);
  expect(response.body).not.toContain("private");
  const large = snapshot(50001, 1);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/result-sets/${large}/custom-chart`,
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(422);
});

it("uses browser auth and CSRF protection for diagnostics GET/POST", async () => {
  const board = operations.createBoard({
    name: "Custom",
    document: document([node(snapshot())]),
  });
  const { app, headers } = await api();
  const url = `/api/boards/${board.id}/nodes/chart/custom-chart-status`;
  const payload = {
    browserId: randomUUID(),
    sequence: 1,
    sentAt: Date.now(),
    resultSetId: board.document.nodes[0].data.resultSetId,
    specHash: createHash("sha256")
      .update(serializeCustomChart(spec))
      .digest("hex"),
    status: "rendered",
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        payload,
        headers: { host: headers.host },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        payload,
        headers: { ...headers, "x-csrf-token": "bad" },
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({ method: "POST", url, payload, headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect((await app.inject({ url, headers })).json().status).toBe("rendered");
  expect(operations.board(board.id)).toEqual(board);
});

it("applies the aggregate size cap only to boards containing custom source and counts UTF-8 bytes", () => {
  const note = {
    id: "note",
    type: "artifact",
    position: { x: 0, y: 0 },
    data: { kind: "note", title: "Large note", text: "я".repeat(200000) },
  };
  const legacy = operations.createBoard({
    name: "Legacy",
    document: document(
      Array.from({ length: 4 }, (_, index) => ({
        ...note,
        id: `note-${index}`,
      })),
    ),
  });
  expect(legacy.document.nodes).toHaveLength(4);
  expect(() =>
    operations.createBoard({
      name: "Custom",
      document: document([
        ...Array.from({ length: 4 }, (_, index) => ({
          ...note,
          id: `note-${index}`,
        })),
        node(snapshot()),
      ]),
    }),
  ).toThrow(expect.objectContaining({ code: "BOARD_TOO_LARGE" }));
});
