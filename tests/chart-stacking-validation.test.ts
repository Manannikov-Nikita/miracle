import { describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/server/validation";

const board = (stacked?: unknown, kind = "bar") => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "chart",
      type: "artifact",
      position: { x: 0, y: 0 },
      data: {
        title: "Продажи по регионам",
        kind: "result",
        resultSetId: "019a1191-293e-7e55-9d78-227dc961f949",
        source: {
          connectionId: "019a1191-293e-7e55-9d78-227dc961f950",
          sql: "SELECT month, region, revenue FROM sales",
        },
        view: "chart",
        chart: {
          kind,
          x: "month",
          y: ["revenue"],
          series: "region",
          legend: true,
          ...(stacked === undefined ? {} : { stacked }),
        },
      },
    },
  ],
  edges: [],
});

describe.each(["bar", "line", "area"])("saved %s stacking", (kind) => {
  it.each([true, false, undefined])(
    "retains stacking %s through board serialization and validation",
    (stacked) => {
      const document = board(stacked, kind);
      expect(
        boardDocumentSchema.parse(JSON.parse(JSON.stringify(document))),
      ).toEqual(document);
    },
  );
  it("rejects a malformed stacking setting", () => {
    expect(boardDocumentSchema.safeParse(board("true", kind)).success).toBe(
      false,
    );
  });
});
