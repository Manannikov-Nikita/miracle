import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/shared/board-schema";
import { resolveShape, shapeSpecSchema } from "../src/shared/shapes";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  createBoardFragment,
  pasteBoardFragment,
  readBoardClipboard,
  writeBoardClipboard,
} from "../src/client/board/clipboard";

const shapeDocument = (shape: unknown = { type: "rectangle" }) => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "shape",
      type: "artifact",
      position: { x: 100, y: 80 },
      width: 240,
      height: 160,
      data: { title: "Фигура", kind: "shape", text: "Привет", shape },
    },
  ],
  edges: [],
});

const styledShape = {
  type: "rounded-rectangle" as const,
  fill: "transparent",
  stroke: "#AB34EF",
  strokeWidth: 3.5,
  strokeStyle: "dotted" as const,
  opacity: 0.65,
  cornerRadius: 22,
  textColor: "#123456",
  fontSize: 32,
  fontFamily: "serif" as const,
  bold: true,
  italic: true,
  underline: true,
  textAlign: "right" as const,
  verticalAlign: "bottom" as const,
};

describe("saved shapes", () => {
  it("accepts a shape node and preserves its data on JSON roundtrip", () => {
    const input = shapeDocument();
    expect(boardDocumentSchema.safeParse(input).success).toBe(true);
    expect(
      boardDocumentSchema.parse(JSON.parse(JSON.stringify(input))),
    ).toEqual(input);
  });

  it.each([
    "rectangle",
    "rounded-rectangle",
    "ellipse",
    "triangle",
    "diamond",
    "hexagon",
    "arrow",
  ])("persists all style fields for %s", (type) => {
    const input = shapeDocument({ ...styledShape, type });
    expect(boardDocumentSchema.parse(input)).toEqual(input);
  });

  it("requires a valid specification for shape nodes", () => {
    for (const shape of [undefined, null, {}, { type: "star" }]) {
      const input = shapeDocument();
      input.nodes[0].data.shape = shape;
      expect(boardDocumentSchema.safeParse(input).success).toBe(false);
    }
  });

  it("keeps legacy note, markdown and result nodes accepted", () => {
    const input = {
      schemaVersion: 1,
      nodes: ["note", "markdown", "result"].map((kind) => ({
        id: kind,
        type: "artifact",
        position: { x: 0, y: 0 },
        data: {
          title: kind,
          kind,
          ...(kind === "result"
            ? {
                resultSetId: randomUUID(),
                source: { connectionId: randomUUID(), sql: "SELECT 1" },
              }
            : { text: "legacy text" }),
        },
      })),
      edges: [],
    };
    expect(boardDocumentSchema.parse(input)).toEqual(input);
  });

  it.each([
    { fill: "red" },
    { fill: "#abc" },
    { fill: "url(https://example.invalid/color)" },
    { stroke: "transparent" },
    { stroke: "#12345678" },
    { textColor: "currentColor" },
    { strokeWidth: -0.1 },
    { strokeWidth: 12.1 },
    { strokeWidth: Infinity },
    { opacity: -0.01 },
    { opacity: 1.01 },
    { opacity: NaN },
    { cornerRadius: -1 },
    { cornerRadius: 51 },
    { fontSize: 7.9 },
    { fontSize: 145 },
    { fontSize: "24" },
    { strokeStyle: "dash" },
    { fontFamily: "Arial" },
    { textAlign: "justify" },
    { verticalAlign: "center" },
    { bold: 1 },
    { italic: "true" },
    { underline: null },
    { svg: "<svg onload='alert(1)'/>" },
  ])("rejects invalid shape settings %j", (patch) => {
    expect(
      boardDocumentSchema.safeParse(
        shapeDocument({ type: "rectangle", ...patch }),
      ).success,
    ).toBe(false);
  });

  it("accepts exact style boundaries and plain text without interpretation", () => {
    const input = shapeDocument({
      type: "rectangle",
      fill: "#aAbBcC",
      strokeWidth: 0,
      opacity: 0,
      cornerRadius: 0,
      fontSize: 8,
    });
    input.nodes[0].data.text = "<b>plain</b> & <svg>text</svg>";
    expect(boardDocumentSchema.parse(input)).toEqual(input);
    expect(
      shapeSpecSchema.parse({
        type: "rectangle",
        strokeWidth: 12,
        opacity: 1,
        cornerRadius: 50,
        fontSize: 144,
      }),
    ).toEqual({
      type: "rectangle",
      strokeWidth: 12,
      opacity: 1,
      cornerRadius: 50,
      fontSize: 144,
    });
  });

  it("retains the 200000-character text and 200-node document limits", () => {
    const input = shapeDocument();
    input.nodes[0].data.text = "a".repeat(200000);
    expect(boardDocumentSchema.safeParse(input).success).toBe(true);
    input.nodes[0].data.text += "a";
    expect(boardDocumentSchema.safeParse(input).success).toBe(false);
    input.nodes[0].data.text = "";
    input.nodes = Array.from({ length: 200 }, (_, index) => ({
      ...input.nodes[0],
      id: `shape-${index}`,
    }));
    expect(boardDocumentSchema.safeParse(input).success).toBe(true);
    input.nodes.push({ ...input.nodes[0], id: "overflow" });
    expect(boardDocumentSchema.safeParse(input).success).toBe(false);
  });
});

describe("shape presentation defaults", () => {
  it("resolves a usable rectangle without changing the saved specification", () => {
    const defaults = {
      type: "rectangle",
      rotation: 0,
      fill: "#dbeafe",
      stroke: "#3b82f6",
      strokeWidth: 2,
      strokeStyle: "solid",
      lineDirection: "horizontal",
      lineStart: "none",
      lineEnd: "none",
      opacity: 1,
      cornerRadius: 0,
      textColor: "#172033",
      fontSize: 24,
      fontFamily: "sans",
      bold: false,
      italic: false,
      underline: false,
      textAlign: "center",
      verticalAlign: "middle",
    };
    expect(resolveShape()).toEqual(defaults);
    const saved = shapeSpecSchema.parse({ type: "rectangle" });
    expect(resolveShape(saved)).toEqual(defaults);
    expect(saved).toEqual({ type: "rectangle" });
  });

  it("defaults rounded corners only for a rounded rectangle", () => {
    expect(resolveShape({ type: "rounded-rectangle" }).cornerRadius).toBe(16);
    expect(resolveShape({ type: "ellipse" }).cornerRadius).toBe(0);
    expect(
      resolveShape({ type: "rounded-rectangle", cornerRadius: 0 }).cornerRadius,
    ).toBe(0);
  });

  it("preserves explicit zero, false, transparency and other style overrides", () => {
    const settings = {
      ...styledShape,
      strokeWidth: 0,
      opacity: 0,
      bold: false,
      italic: false,
      underline: false,
    };
    expect(resolveShape(settings)).toEqual({
      ...settings,
      rotation: 0,
      lineDirection: "horizontal",
      lineStart: "none",
      lineEnd: "none",
    });
  });
});

describe("shape persistence and copy", () => {
  let directory: string;
  let db: Database;
  let store: ProjectStore;
  let operations: WorkspaceOperations;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "miracle-shapes-"));
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

  it.each(["board", "presentation"])(
    "saves and reloads all shape styles in a %s",
    (kind) => {
      const document = shapeDocument(styledShape);
      const input =
        kind === "presentation"
          ? {
              ...document,
              kind,
              slides: [
                { id: "slide", title: "Слайд 1", background: "#ffffff" },
              ],
              nodes: document.nodes.map((node) => ({
                ...node,
                slideId: "slide",
              })),
            }
          : document;
      const created = operations.createBoard({
        name: "Фигуры",
        document: input,
      });
      expect(operations.board(created.id).document).toEqual(input);
      const changed = structuredClone(created.document);
      changed.nodes[0].data.shape = {
        ...styledShape,
        type: "triangle",
        fill: "#ff0000",
      };
      changed.nodes[0].data.text = "Изменённый текст";
      const saved = operations.updateBoard(created.id, {
        baseRevision: created.revision,
        mutationId: randomUUID(),
        document: changed,
      });
      expect(operations.board(saved.id).document).toEqual(changed);
    },
  );

  it("applies agent shape updates as full replacements while keeping text", () => {
    const created = operations.createBoard({
      name: "Фигуры",
      document: shapeDocument(styledShape),
    });
    const saved = operations.patchBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      operations: [
        {
          type: "update_node",
          id: "shape",
          patch: { data: { shape: { type: "hexagon", strokeWidth: 0 } } },
        },
      ],
    });
    expect(operations.board(saved.id).document.nodes[0].data).toEqual({
      title: "Фигура",
      kind: "shape",
      text: "Привет",
      shape: { type: "hexagon", strokeWidth: 0 },
    });
  });

  it("rejects an invalid agent update atomically", () => {
    const created = operations.createBoard({
      name: "Фигуры",
      document: shapeDocument(styledShape),
    });
    expect(() =>
      operations.patchBoard(created.id, {
        baseRevision: created.revision,
        mutationId: randomUUID(),
        operations: [
          {
            type: "update_node",
            id: "shape",
            patch: {
              data: {
                text: "Must not persist",
                shape: { type: "arrow", opacity: 2 },
              },
            },
          },
        ],
      }),
    ).toThrow();
    expect(operations.board(created.id)).toEqual(created);
  });

  it("roundtrips clipboard shape data into a new node and saves its styles", () => {
    const created = operations.createBoard({
      name: "Фигуры",
      document: shapeDocument(styledShape),
    });
    const fragment = createBoardFragment(
      created,
      "workspace",
      new Set(["shape"]),
    );
    expect(fragment).not.toBeNull();
    const data = new Map<string, string>();
    const clipboard = {
      getData: (type: string) => data.get(type) ?? "",
      setData: (type: string, value: string) => {
        data.set(type, value);
      },
    };
    writeBoardClipboard(clipboard, fragment!);
    const copied = readBoardClipboard(clipboard);
    expect(copied).not.toBeNull();
    const pasted = pasteBoardFragment(copied!, created, { x: 600, y: 400 }, 0);
    const saved = operations.updateBoard(created.id, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
      document: pasted.document,
    });
    const nodes = operations.board(saved.id).document.nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].id).not.toBe(nodes[0].id);
    expect(nodes[1].position).not.toEqual(nodes[0].position);
    expect(nodes[1].data).toEqual({
      title: "Фигура",
      kind: "shape",
      text: "Привет",
      shape: styledShape,
    });
    expect(nodes[1].width).toBe(240);
    expect(nodes[1].height).toBe(160);
  });
});
