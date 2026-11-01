import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/server/validation";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";

const document = (appearance?: unknown) => ({
  schemaVersion: 1,
  nodes: ["first", "second"].map((id, index) => ({
    id,
    type: "artifact",
    position: { x: index * 400, y: 0 },
    data: { title: id, kind: "note", text: "" },
  })),
  edges: [
    {
      id: "connection",
      source: "first",
      target: "second",
      sourceHandle: "right",
      targetHandle: "left",
      label: "Existing label",
      ...(appearance === undefined ? {} : { appearance }),
    },
  ],
});

describe("saved arrow appearance", () => {
  it("keeps legacy arrows unchanged", () => {
    expect(boardDocumentSchema.parse(document())).toEqual(document());
  });

  it.each([
    {},
    {
      path: "straight",
      line: "solid",
      color: "#AABBCC",
      width: 1,
      startArrow: false,
      endArrow: true,
    },
    {
      path: "smoothstep",
      line: "dashed",
      color: "#aabbcc",
      width: 2,
      startArrow: true,
      endArrow: false,
    },
    {
      path: "bezier",
      line: "dotted",
      color: "#000000",
      width: 3,
      startArrow: true,
      endArrow: true,
    },
    { color: "#91cbb3" },
  ])("round-trips appearance %j without losing settings", (appearance) => {
    const input = document(appearance);
    expect(
      boardDocumentSchema.parse(JSON.parse(JSON.stringify(input))),
    ).toEqual(input);
  });

  it.each(
    [
      null,
      [],
      "red",
      { path: "curve" },
      { line: "dash" },
      { color: "red" },
      { color: "#abc" },
      { color: "#12345678" },
      { color: "url(https://example.invalid/color)" },
      { width: 0 },
      { width: 4 },
      { width: 1.5 },
      { width: "2" },
      { startArrow: 1 },
      { endArrow: "true" },
      { stroke: "red" },
      { color: "#123456", unknown: true },
    ].map((appearance) => ({ appearance })),
  )("rejects unsupported appearance $appearance", ({ appearance }) => {
    expect(boardDocumentSchema.safeParse(document(appearance)).success).toBe(
      false,
    );
  });
});

describe("arrow appearance persistence", () => {
  let directory: string;
  let db: Database;
  let store: ProjectStore;
  let operations: WorkspaceOperations;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "miracle-edge-appearance-"));
    db = new Database(directory);
    migrate(db, () => {});
    store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
      projectRoot: directory,
      dataDir: directory,
      workspaceId: randomUUID(),
      instanceId: randomUUID(),
    });
    operations = new WorkspaceOperations(store, async () => {});
  });
  afterEach(() => {
    store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists arrow style through board creation, normal saves and reloads", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document({ color: "#91cbb3" }),
    });
    expect(operations.board(created.id).document.edges[0]).toMatchObject({
      appearance: { color: "#91cbb3" },
      label: "Existing label",
    });
    const saved = operations.updateBoard(created.id, {
      baseRevision: created.revision,
      document: document({
        path: "bezier",
        line: "dotted",
        color: "#91b5ff",
        width: 3,
        startArrow: false,
        endArrow: true,
      }),
    });
    expect(operations.board(saved.id).document.edges[0]).toEqual({
      id: "connection",
      source: "first",
      target: "second",
      sourceHandle: "right",
      targetHandle: "left",
      label: "Existing label",
      appearance: {
        path: "bezier",
        line: "dotted",
        color: "#91b5ff",
        width: 3,
        startArrow: false,
        endArrow: true,
      },
    });
  });

  it("updates an arrow appearance and a 500-character label via operations", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document(),
    });
    const saved = operations.patchBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      operations: [
        {
          type: "update_edge",
          id: "connection",
          patch: {
            label: "a".repeat(500),
            appearance: { path: "straight", width: 2, endArrow: false },
          },
        },
      ],
    });
    expect(operations.board(saved.id).document.edges[0]).toMatchObject({
      label: "a".repeat(500),
      appearance: { path: "straight", width: 2, endArrow: false },
      source: "first",
      target: "second",
    });
  });

  it.each([
    { appearance: { width: 4 } },
    { appearance: { color: "#123456", bad: true } },
    { label: "a".repeat(501) },
  ])(
    "rejects invalid operation patch without modifying the saved board",
    (patch) => {
      const created = operations.createBoard({
        name: "Board",
        document: document(),
      });
      expect(() =>
        operations.patchBoard(created.id, {
          baseRevision: created.revision,
          mutationId: randomUUID(),
          operations: [{ type: "update_edge", id: "connection", patch }],
        }),
      ).toThrow();
      expect(operations.board(created.id)).toEqual(created);
    },
  );
});
