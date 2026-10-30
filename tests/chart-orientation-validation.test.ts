import { describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/server/validation";

const board = (orientation?: unknown, kind = "bar") => ({
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
          sql: "SELECT region, revenue FROM sales",
        },
        view: "chart",
        chart: {
          kind,
          x: "region",
          y: ["revenue"],
          legend: true,
          ...(orientation === undefined ? {} : { orientation }),
        },
      },
    },
  ],
  edges: [],
});

describe("saved chart orientation", () => {
  it.each([undefined, "vertical", "horizontal"])(
    "round-trips orientation %s without changing legacy boards",
    (orientation) => {
      const document = board(orientation);
      expect(
        boardDocumentSchema.parse(JSON.parse(JSON.stringify(document))),
      ).toEqual(document);
    },
  );
  it.each(["line", "area", "scatter"])(
    "retains the bar orientation when switching to %s",
    (kind) => {
      const document = board("horizontal", kind);
      expect(boardDocumentSchema.parse(document)).toEqual(document);
    },
  );
  it.each(
    ["diagonal", "Horizontal", "", true, 1, null, {}, []].map(
      (orientation) => ({
        orientation,
      }),
    ),
  )("rejects malformed orientation $orientation", ({ orientation }) => {
    expect(boardDocumentSchema.safeParse(board(orientation)).success).toBe(
      false,
    );
  });
});
