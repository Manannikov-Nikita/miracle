// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createToolNode } from "../src/client/board/canvas-tools";
import { nativeBoardClipboardTarget } from "../src/client/board/clipboard";
import { boardDocumentSchema } from "../src/shared/board-schema";
import { createEmptyVisualTable } from "../src/shared/visual-table";

describe("editable table board contract", () => {
  it("creates independent editable tables at the dropped position", () => {
    const a = createToolNode(
      { kind: "table" },
      { x: 400, y: 300 },
      { id: "a" },
    )!;
    const b = createToolNode(
      { kind: "table" },
      { x: 400, y: 300 },
      { id: "b" },
    )!;
    expect(a.data.kind).toBe("table");
    expect(a.position.x + a.width! / 2).toBe(400);
    expect(a.position.y + a.height! / 2).toBe(300);
    expect(a.data.visualTable?.rows?.length).toBeGreaterThan(0);
    expect(a.data.visualTable?.rows?.[0].id).not.toBe(
      b.data.visualTable?.rows?.[0].id,
    );
    expect(
      boardDocumentSchema.safeParse({
        schemaVersion: 1,
        nodes: [a, b],
        edges: [],
      }).success,
    ).toBe(true);
  });
  it("validates nested local cell edits rather than accepting arbitrary passthrough data", () => {
    const table = createEmptyVisualTable();
    const data = { kind: "table", title: "Local table", visualTable: table };
    const document = {
      schemaVersion: 1,
      edges: [],
      nodes: [{ id: "n", type: "artifact", position: { x: 0, y: 0 }, data }],
    };
    expect(boardDocumentSchema.safeParse(document).success).toBe(true);
    table.edits.push({
      rowId: "nonexistent",
      columnId: table.columns[0].id,
      value: "orphan",
    });
    expect(boardDocumentSchema.safeParse(document).success).toBe(false);
  });
  it("keeps cell clipboard operations within the table instead of copying the selected board node", () => {
    const table = document.createElement("div");
    table.className = "board-sql-table";
    const cell = document.createElement("div");
    cell.setAttribute("role", "gridcell");
    table.append(cell);
    expect(nativeBoardClipboardTarget(cell)).toBe(true);
  });
});
