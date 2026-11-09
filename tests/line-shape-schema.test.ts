import { describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/shared/board-schema";
import { resolveShape, shapeSpecSchema } from "../src/shared/shapes";

describe("standalone line shapes", () => {
  it.each(["horizontal", "vertical", "diagonal-down", "diagonal-up"])(
    "preserves a %s line and its arrowheads as a node without connections",
    (lineDirection) => {
      const document = {
        schemaVersion: 1,
        nodes: [
          {
            id: "visual-line",
            type: "artifact",
            position: { x: 100, y: 80 },
            width: 260,
            height: 40,
            data: {
              title: "Линия",
              kind: "shape",
              text: "",
              shape: {
                type: "line",
                lineDirection,
                lineStart: "arrow",
                lineEnd: "arrow",
                stroke: "#123456",
                strokeWidth: 3,
                strokeStyle: "dashed",
              },
            },
          },
        ],
        edges: [],
      };
      expect(
        boardDocumentSchema.parse(JSON.parse(JSON.stringify(document))),
      ).toEqual(document);
    },
  );

  it("resolves an unstyled line without fill or arrowheads", () => {
    const line = shapeSpecSchema.parse({ type: "line" });
    expect(resolveShape(line)).toMatchObject({
      type: "line",
      fill: "transparent",
      lineDirection: "horizontal",
      lineStart: "none",
      lineEnd: "none",
      strokeWidth: 2,
    });
    expect(resolveShape({ ...line, lineEnd: "arrow" }).lineStart).toBe("none");
  });

  it.each([
    { lineDirection: "curved" },
    { lineDirection: 45 },
    { lineStart: "circle" },
    { lineEnd: true },
    { lineEnd: "url(#untrusted)" },
  ])("rejects invalid line geometry or endings: %j", (patch) => {
    expect(shapeSpecSchema.safeParse({ type: "line", ...patch }).success).toBe(
      false,
    );
  });

  it("keeps the filled arrow and legacy shape appearance unchanged", () => {
    expect(resolveShape({ type: "arrow" })).toMatchObject({
      type: "arrow",
      fill: "#dbeafe",
      stroke: "#3b82f6",
      strokeWidth: 2,
    });
    expect(resolveShape({ type: "rounded-rectangle" }).cornerRadius).toBe(16);
    expect(
      shapeSpecSchema.parse({ type: "rectangle", fill: "#abcdef" }),
    ).toEqual({ type: "rectangle", fill: "#abcdef" });
  });
});
