import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/shared/board-schema";
import { resolveTextStyle, textStyleSchema } from "../src/shared/text-style";
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

const style = {
  fontFamily: "serif",
  fontSize: 48,
  textColor: "#123456",
  bold: true,
  italic: true,
  underline: true,
  textAlign: "right",
  verticalAlign: "bottom",
};
const textDocument = (textStyle: unknown = style) => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "text",
      type: "artifact",
      position: { x: 100, y: 80 },
      width: 320,
      height: 100,
      data: {
        title: "Текст",
        kind: "text",
        text: "Заголовок\nВторая строка",
        textStyle,
      },
    },
  ],
  edges: [],
});

describe("standalone text blocks", () => {
  it("accepts typography and preserves plain multiline text on roundtrip", () => {
    const document = textDocument();
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      boardDocumentSchema.parse(JSON.parse(JSON.stringify(document))),
    ).toEqual(document);
  });

  it("accepts text blocks without explicit font settings", () => {
    const document = textDocument();
    delete (document.nodes[0].data as { textStyle?: unknown }).textStyle;
    expect(boardDocumentSchema.parse(document)).toEqual(document);
  });

  it("resolves text defaults without altering the saved settings", () => {
    const saved = textStyleSchema.parse({ fontFamily: "mono", bold: false });
    expect(resolveTextStyle(saved)).toEqual({
      fontFamily: "mono",
      fontSize: 32,
      textColor: "#172033",
      bold: false,
      italic: false,
      underline: false,
      textAlign: "left",
      verticalAlign: "top",
    });
    expect(saved).toEqual({ fontFamily: "mono", bold: false });
    expect(resolveTextStyle().fontFamily).toBe("sans");
  });

  it.each([
    { fontSize: 7 },
    { fontSize: 145 },
    { fontSize: Infinity },
    { fontSize: "32" },
    { fontFamily: "url(https://example.invalid/font)" },
    { textColor: "red" },
    { textColor: "#12345678" },
    { bold: 1 },
    { italic: "true" },
    { underline: null },
    { textAlign: "justify" },
    { verticalAlign: "center" },
    { css: "position:fixed" },
  ])("rejects invalid text styles %j", (invalid) => {
    expect(boardDocumentSchema.safeParse(textDocument(invalid)).success).toBe(
      false,
    );
  });

  it("retains the text length limit for standalone text", () => {
    const document = textDocument();
    document.nodes[0].data.text = "a".repeat(200000);
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
    document.nodes[0].data.text += "a";
    expect(boardDocumentSchema.safeParse(document).success).toBe(false);
  });
});

describe("text block persistence and copy", () => {
  let directory: string;
  let db: Database;
  let store: ProjectStore;
  let operations: WorkspaceOperations;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "miracle-text-"));
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
    "saves and patches text styles in a %s",
    (kind) => {
      const document = textDocument();
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
        name: "Текст",
        document: input,
      });
      expect(operations.board(created.id).document).toEqual(input);
      const saved = operations.patchBoard(created.id, {
        baseRevision: created.revision,
        mutationId: randomUUID(),
        operations: [
          {
            type: "update_node",
            id: "text",
            patch: {
              data: {
                text: "Изменённый текст",
                textStyle: { fontFamily: "mono", bold: false },
              },
            },
          },
        ],
      });
      expect(operations.board(saved.id).document.nodes[0].data).toEqual({
        title: "Текст",
        kind: "text",
        text: "Изменённый текст",
        textStyle: { fontFamily: "mono", bold: false },
      });
    },
  );

  it("rejects invalid font updates atomically", () => {
    const created = operations.createBoard({
      name: "Текст",
      document: textDocument(),
    });
    expect(() =>
      operations.patchBoard(created.id, {
        baseRevision: created.revision,
        mutationId: randomUUID(),
        operations: [
          {
            type: "update_node",
            id: "text",
            patch: {
              data: { text: "Must not persist", textStyle: { fontSize: -1 } },
            },
          },
        ],
      }),
    ).toThrow();
    expect(operations.board(created.id)).toEqual(created);
  });

  it("copies text from a board to a slide with new identity and unchanged typography", () => {
    const source = operations.createBoard({
      name: "Текст",
      document: textDocument(),
    });
    const target = operations.createBoard({
      name: "Слайды",
      kind: "presentation",
    });
    const fragment = createBoardFragment(
      source,
      "workspace",
      new Set(["text"]),
    );
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
    const slideId = target.document.slides![0].id;
    const pasted = pasteBoardFragment(copied!, target, { x: 800, y: 450 }, 0, {
      slideId,
    });
    const saved = operations.updateBoard(target.id, {
      baseRevision: target.revision,
      mutationId: randomUUID(),
      document: pasted.document,
    });
    const node = operations.board(saved.id).document.nodes[0];
    expect(node.id).not.toBe("text");
    expect(node.slideId).toBe(slideId);
    expect(node.data).toEqual(source.document.nodes[0].data);
    expect(operations.board(source.id)).toEqual(source);
  });
});
