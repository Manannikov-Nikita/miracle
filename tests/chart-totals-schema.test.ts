import { describe, expect, it } from "vitest";
import {
  boardDocumentSchema,
  chartSpecSchema,
} from "../src/shared/board-schema";
import { chartInputSchema } from "../src/server/chart-guide";
import { normalizeChartSpec } from "../src/client/board/chartTableModel";
import type { ChartSpec } from "../src/shared/types";

const columns = [
  { id: "month", name: "Месяц", type: "String" },
  { id: "value", name: "Выручка", type: "Float64" },
  { id: "group", name: "Регион", type: "String" },
];
const base: ChartSpec = {
  kind: "bar",
  x: "month",
  y: ["value"],
  series: "group",
  stacked: true,
  legend: true,
};
const documentWith = (chart: unknown) => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "chart",
      type: "artifact",
      position: { x: 0, y: 0 },
      data: {
        kind: "result",
        title: "Выручка",
        view: "chart",
        resultSetId: "11111111-1111-4111-8111-111111111111",
        source: {
          connectionId: "22222222-2222-4222-8222-222222222222",
          sql: "select month, value, region",
        },
        chart,
      },
    },
  ],
  edges: [],
});

describe("stacked totals persistence", () => {
  it.each([true, false])(
    "round-trips an explicit totals preference: %s",
    (showTotals) => {
      const document = documentWith({ ...base, showTotals });
      expect(
        boardDocumentSchema.parse(JSON.parse(JSON.stringify(document))),
      ).toEqual(document);
    },
  );

  it("keeps old documents without a stored totals setting unchanged", () => {
    expect(boardDocumentSchema.parse(documentWith(base))).toEqual(
      documentWith(base),
    );
  });

  it.each([null, "false", 0, 1])(
    "rejects a non-boolean totals preference: %j",
    (showTotals) => {
      expect(chartSpecSchema.safeParse({ ...base, showTotals }).success).toBe(
        false,
      );
    },
  );

  it.each(["line", "area", "scatter"] as const)(
    "retains a saved preference through a temporary %s chart",
    (kind) => {
      const stored = chartSpecSchema.parse({ ...base, showTotals: false });
      const switched = normalizeChartSpec(columns, { ...stored, kind });
      const saved = boardDocumentSchema.parse(documentWith(switched));
      const returned = normalizeChartSpec(columns, {
        ...saved.nodes[0].data.chart!,
        kind: "bar",
      });
      expect(returned.showTotals).toBe(false);
      expect(returned).toMatchObject({ series: "group", stacked: true });
    },
  );

  it("advertises totals as an optional boolean to agent tools", () => {
    const schema = chartInputSchema.properties as Record<
      string,
      { type?: string }
    >;
    expect(schema.showTotals?.type).toBe("boolean");
    expect(chartInputSchema.required).not.toContain("showTotals");
  });
});
