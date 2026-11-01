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

const document = (edges: Record<string, unknown>[] = []) => ({
  schemaVersion: 1,
  nodes: ["first", "second", "third"].map((id, index) => ({
    id,
    type: "artifact",
    position: { x: index * 400, y: 0 },
    data: { title: id, kind: "note", text: "" },
  })),
  edges,
});
const attached = {
  id: "arrow",
  source: "first",
  sourceHandle: "right",
  target: "second",
  targetHandle: "left",
  label: "Existing label",
  appearance: { line: "dashed", color: "#a4c3b2" },
};
const free = {
  id: "free",
  sourcePoint: { x: -100, y: 50 },
  targetPoint: { x: 500, y: 150 },
  label: "Free label",
  labelPosition: 0.75,
  appearance: { path: "straight", width: 2 },
};

describe("arrow endpoint validation", () => {
  it.each([
    attached,
    free,
    { id: "mixed", source: "first", targetPoint: { x: 10, y: 20 } },
    { id: "mixed", sourcePoint: { x: 10, y: 20 }, target: "second" },
    {
      id: "limits",
      sourcePoint: { x: -1_000_000, y: 1_000_000 },
      targetPoint: { x: 1_000_000, y: -1_000_000 },
      labelPosition: 0,
    },
    { ...free, labelPosition: 1 },
  ])("round-trips attached, free and mixed endpoints: %j", (edge) => {
    const input = document([edge]);
    expect(boardDocumentSchema.parse(input)).toEqual(input);
  });

  it("does not require blocks for fully free arrows", () => {
    const input = { ...document([free]), nodes: [] };
    expect(boardDocumentSchema.parse(input)).toEqual(input);
  });

  it.each([
    { id: "arrow", target: "second" },
    { id: "arrow", source: "first" },
    { ...attached, sourcePoint: { x: 1, y: 2 } },
    { ...attached, targetPoint: { x: 1, y: 2 } },
    { ...free, source: null },
    { ...free, sourcePoint: null },
    { ...attached, source: "" },
    { ...attached, target: "missing" },
    { id: "mixed", source: "missing", targetPoint: { x: 1, y: 2 } },
    { id: "mixed", sourcePoint: { x: 1, y: 2 }, target: "missing" },
    { ...free, sourcePoint: { x: Number.NaN, y: 0 } },
    { ...free, sourcePoint: { x: Number.POSITIVE_INFINITY, y: 0 } },
    { ...free, targetPoint: { x: 0, y: Number.NEGATIVE_INFINITY } },
    { ...free, sourcePoint: { x: 1_000_001, y: 0 } },
    { ...free, targetPoint: { x: 0, y: -1_000_001 } },
    { ...free, sourcePoint: { x: 1 } },
    { ...free, targetPoint: { x: "1", y: 0 } },
    { ...free, sourcePoint: { x: 1, y: 2, z: 3 } },
    { ...free, labelPosition: -0.01 },
    { ...free, labelPosition: 1.01 },
    { ...free, labelPosition: Number.NaN },
    { ...free, labelPosition: Number.POSITIVE_INFINITY },
    { ...free, labelPosition: null },
    { ...free, labelPosition: "0.5" },
  ])("rejects an invalid arrow endpoint or label position: %j", (edge) => {
    expect(boardDocumentSchema.safeParse(document([edge])).success).toBe(false);
  });
});

describe("manual arrow bend validation", () => {
  it.each([
    { x: 0, y: 0 },
    { x: 75.5, y: -120.25 },
    { x: -1_000_000, y: 1_000_000 },
  ])("preserves the explicit midpoint offset %j", (bend) => {
    const input = document([
      { ...attached, bend },
      { ...free, bend },
    ]);
    expect(boardDocumentSchema.parse(input)).toEqual(input);
  });

  it.each([
    { bend: null },
    { bend: "automatic" },
    { bend: { x: Number.NaN, y: 0 } },
    { bend: { x: 0, y: Number.POSITIVE_INFINITY } },
    { bend: { x: -1_000_001, y: 0 } },
    { bend: { x: 0, y: 1_000_001 } },
    { bend: { x: 1 } },
    { bend: { x: "1", y: 0 } },
    { bend: { x: 1, y: 2, z: 3 } },
  ])("rejects invalid manual offsets: %j", ({ bend }) => {
    expect(
      boardDocumentSchema.safeParse(document([{ ...free, bend }])).success,
    ).toBe(false);
  });
});

describe("free arrow persistence and operations", () => {
  let directory: string;
  let db: Database;
  let store: ProjectStore;
  let operations: WorkspaceOperations;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "miracle-edge-endpoints-"));
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

  it("preserves free geometry, labels and appearance through normal board saves", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document([free]),
    });
    expect(operations.board(created.id).document.edges).toEqual([free]);
    const moved = {
      ...free,
      sourcePoint: { x: 50, y: 70 },
      targetPoint: { x: 750, y: 250 },
      labelPosition: 0.2,
    };
    const saved = operations.updateBoard(created.id, {
      baseRevision: created.revision,
      document: document([moved]),
    });
    expect(operations.board(saved.id).document.edges).toEqual([moved]);
  });

  it("supports free arrows through add_edge", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document(),
    });
    const saved = operations.patchBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      operations: [{ type: "add_edge", edge: free }],
    });
    expect(operations.board(saved.id).document.edges).toEqual([free]);
  });

  it("detaches and reattaches endpoints atomically while preserving unrelated fields", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document([attached]),
    });
    const detached = operations.patchBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      operations: [
        {
          type: "update_edge",
          id: "arrow",
          patch: {
            source: null,
            sourceHandle: null,
            sourcePoint: { x: 50, y: 80 },
            labelPosition: 0.3,
          },
        },
      ],
    });
    const { source, sourceHandle, ...remaining } = attached;
    expect(operations.board(created.id).document.edges).toEqual([
      {
        ...remaining,
        sourcePoint: { x: 50, y: 80 },
        labelPosition: 0.3,
      },
    ]);
    const reattached = operations.patchBoard(created.id, {
      baseRevision: detached.revision,
      mutationId: randomUUID(),
      operations: [
        {
          type: "update_edge",
          id: "arrow",
          patch: {
            source: "third",
            sourceHandle: "top",
            sourcePoint: null,
            target: null,
            targetHandle: null,
            targetPoint: { x: 800, y: 200 },
            labelPosition: null,
          },
        },
      ],
    });
    expect(operations.board(reattached.id).document.edges).toEqual([
      {
        id: "arrow",
        source: "third",
        sourceHandle: "top",
        targetPoint: { x: 800, y: 200 },
        label: attached.label,
        appearance: attached.appearance,
      },
    ]);
  });

  it.each([
    { sourcePoint: { x: 0, y: 0 } },
    { source: null },
    { target: "missing" },
    { source: null, sourcePoint: { x: 1_000_001, y: 0 } },
    { labelPosition: 1.1 },
    { unsupported: true },
  ])(
    "rejects the entire batch when an endpoint patch is invalid: %j",
    (patch) => {
      const created = operations.createBoard({
        name: "Board",
        document: document([attached]),
      });
      expect(() =>
        operations.patchBoard(created.id, {
          baseRevision: created.revision,
          mutationId: randomUUID(),
          operations: [
            {
              type: "update_edge",
              id: "arrow",
              patch: { label: "Must not persist" },
            },
            { type: "update_edge", id: "arrow", patch },
          ],
        }),
      ).toThrow();
      expect(operations.board(created.id)).toEqual(created);
    },
  );

  it("preserves bends through board creation, normal save and reload without changing legacy arrows", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document([attached, { ...free, bend: { x: -50, y: 75 } }]),
    });
    expect(operations.board(created.id).document.edges).toEqual([
      attached,
      { ...free, bend: { x: -50, y: 75 } },
    ]);
    const saved = operations.updateBoard(created.id, {
      baseRevision: created.revision,
      document: document([attached, { ...free, bend: { x: 100, y: -125 } }]),
    });
    expect(operations.board(saved.id).document.edges).toEqual([
      attached,
      { ...free, bend: { x: 100, y: -125 } },
    ]);
  });

  it("adds a bent arrow through add_edge", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document(),
    });
    const bent = { ...free, bend: { x: 60, y: -45 } };
    const saved = operations.patchBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      operations: [{ type: "add_edge", edge: bent }],
    });
    expect(operations.board(saved.id).document.edges).toEqual([bent]);
  });

  it("changes the path and bend together, then clears only the bend via null", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document([free]),
    });
    const appearance = { ...free.appearance, path: "bezier" };
    const bent = operations.patchBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      operations: [
        {
          type: "update_edge",
          id: free.id,
          patch: { appearance, bend: { x: -80, y: 140 } },
        },
      ],
    });
    expect(operations.board(bent.id).document.edges).toEqual([
      { ...free, appearance, bend: { x: -80, y: 140 } },
    ]);
    const cleared = operations.patchBoard(created.id, {
      baseRevision: bent.revision,
      mutationId: randomUUID(),
      operations: [{ type: "update_edge", id: free.id, patch: { bend: null } }],
    });
    expect(operations.board(cleared.id).document.edges).toEqual([
      { ...free, appearance },
    ]);
    expect(operations.board(cleared.id).document.edges[0]).not.toHaveProperty(
      "bend",
    );
  });

  it("rejects an invalid bend without persisting any path or earlier batch changes", () => {
    const created = operations.createBoard({
      name: "Board",
      document: document([free]),
    });
    expect(() =>
      operations.patchBoard(created.id, {
        baseRevision: created.revision,
        mutationId: randomUUID(),
        operations: [
          {
            type: "update_edge",
            id: free.id,
            patch: { label: "Must not persist" },
          },
          {
            type: "update_edge",
            id: free.id,
            patch: {
              appearance: { path: "bezier" },
              bend: { x: 1_000_001, y: 0 },
            },
          },
        ],
      }),
    ).toThrow();
    expect(operations.board(created.id)).toEqual(created);
  });

  it("removes only arrows attached to the removed node", () => {
    const unrelated = { id: "unrelated", source: "second", target: "third" };
    const created = operations.createBoard({
      name: "Board",
      document: document([
        attached,
        { id: "mixed", sourcePoint: { x: 10, y: 20 }, target: "first" },
        free,
        unrelated,
      ]),
    });
    const saved = operations.patchBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      operations: [{ type: "remove_node", id: "first" }],
    });
    expect(operations.board(saved.id).document.edges).toEqual([
      free,
      unrelated,
    ]);
  });
});
