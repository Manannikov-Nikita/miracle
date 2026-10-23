import { describe, expect, it } from "vitest";
import {
  applyRefresh,
  chartNumber,
  chartSeries,
  isNumericColumn,
  createResultNode,
  rebindResult,
  removeNode,
} from "../src/client/board/model";
import type { ResultSet } from "../src/shared/types";
const result: ResultSet = {
  id: "r1",
  columns: [
    { id: "x", name: "name", type: "String" },
    { id: "y", name: "amount", type: "Decimal(20,4)" },
  ],
  rowCount: 2,
  byteCount: 10,
  createdAt: "",
  source: { connectionId: "c1", sql: "select 1" },
};
describe("board snapshots", () => {
  it("keeps frozen source and blocks late refresh after explicit rebind", () => {
    const first = createResultNode(result);
    const rebound = rebindResult(first, {
      ...result,
      id: "r2",
      source: { ...result.source, sql: "select 2" },
    });
    const document = { schemaVersion: 1 as const, nodes: [rebound], edges: [] };
    expect(
      applyRefresh(document, first.id, 1, "obsolete").nodes[0].data.resultSetId,
    ).toBe("r2");
    expect(rebound.data.sourceRevision).toBe(2);
    expect(first.data.source?.sql).toBe("select 1");
  });
  it("deletes dangling edges together with a node", () => {
    const node = createResultNode(result);
    expect(
      removeNode(
        {
          schemaVersion: 1,
          nodes: [node],
          edges: [{ id: "e", source: node.id, target: "another" }],
        },
        node.id,
      ).edges,
    ).toEqual([]);
  });
});
describe("full dataset chart safety", () => {
  it("rejects unsafe integers and decimals instead of rounding them", () => {
    for (const value of [
      "9007199254740993",
      "0.1234567890123456789",
      9007199254740992,
    ])
      expect(() => chartNumber(value, result.columns[1])).toThrow(
        /точност|значащих/,
      );
  });
  it("recognizes only numeric database types, including nested wrappers", () => {
    expect(
      isNumericColumn({ id: "x", name: "x", type: "Interval day to second" }),
    ).toBe(false);
    expect(
      isNumericColumn({
        id: "x",
        name: "x",
        type: "LowCardinality(Nullable(Decimal(20,4)))",
      }),
    ).toBe(true);
  });
  it("rejects decimal underflow rather than displaying zero", () => {
    expect(() => chartNumber("1e-999", result.columns[1])).toThrow(/мало/);
  });
  it("uses typed numeric fields and preserves null gaps", () => {
    expect(() => chartNumber("12", result.columns[0])).toThrow(/числовой/);
    expect(
      chartSeries(
        result.columns,
        [
          ["a", "12.5"],
          ["b", null],
        ],
        { kind: "line", x: "x", y: ["y"], legend: true },
      )[0].data,
    ).toEqual([
      ["a", 12.5],
      ["b", null],
    ]);
  });
  it("counts all plotted series toward the limit", () => {
    expect(() =>
      chartSeries(
        result.columns,
        Array.from({ length: 2501 }, () => ["a", "1"]),
        { kind: "bar", x: "x", y: ["y", "y"], legend: true },
      ),
    ).toThrow(/5 000/);
  });
  it("groups series and sorts numeric scatter values", () => {
    const columns = [
      { id: "x", name: "x", type: "Int64" },
      { id: "y", name: "y", type: "Float64" },
      { id: "s", name: "group", type: "String" },
    ];
    expect(
      chartSeries(
        columns,
        [
          [10, 2, "A"],
          [2, 3, "A"],
        ],
        {
          kind: "scatter",
          x: "x",
          y: ["y"],
          series: "s",
          legend: true,
          sort: "asc",
        },
      )[0].data,
    ).toEqual([
      [2, 3],
      [10, 2],
    ]);
  });
});
