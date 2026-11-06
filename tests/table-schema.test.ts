import { describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/server/validation";

const document = (table: unknown) => ({
  schemaVersion: 1,
  edges: [],
  nodes: [
    {
      id: "n",
      type: "artifact",
      position: { x: 0, y: 0 },
      data: { kind: "note", title: "Table contract", table },
    },
  ],
});
const valid = {
  version: 1,
  sourceSchema: '[["0","amount","Decimal(18,2)"]]',
  columns: {
    "0": {
      format: "currency",
      currency: "RUB",
      decimals: 2,
      thresholds: [{ value: "9007199254740993", color: "green" }],
      mappings: [{ value: null, text: "Нет данных" }],
      summary: "sum",
    },
  },
  pivot: { row: "0", column: "1", value: "2", aggregate: "avg" },
  filters: [{ column: "0", op: "gte", value: "0.1" }],
  frozenColumns: 1,
  wrap: true,
};
describe("saved table settings contract", () => {
  it.each([
    {
      kind: "melt",
      columns: ["1", "2"],
      keyName: "Month",
      valueName: "Amount",
    },
    { kind: "pivot", rows: ["0", "3"], column: "1", value: "2" },
    { kind: "pivot", rows: [], column: "1", value: "2" },
  ])("retains reshape settings without aggregation %#", (reshape) => {
    const table = { ...valid, pivot: undefined, reshape };
    expect(
      boardDocumentSchema.parse(document(table)).nodes[0].data.table,
    ).toEqual(table);
  });
  it.each([
    { kind: "melt", columns: [] },
    { kind: "melt", columns: ["1", "1"] },
    { kind: "melt", columns: ["1"], keyName: " " },
    { kind: "melt", columns: ["1"], valueName: "x".repeat(201) },
    { kind: "melt", columns: ["1"], keyName: "Same", valueName: "Same" },
    { kind: "melt", columns: ["1"], keyName: "Значение" },
    { kind: "melt", columns: ["1"], aggregate: "sum" },
    { kind: "pivot", rows: ["0", "0"], column: "1", value: "2" },
    { kind: "pivot", rows: ["0"], column: "0", value: "2" },
    { kind: "pivot", rows: [], column: "1", value: "1" },
    { kind: "pivot", rows: [], column: "1", value: "2", aggregate: "sum" },
    {
      kind: "pivot",
      rows: Array.from({ length: 2001 }, (_, i) => String(i)),
      column: "x",
      value: "y",
    },
  ])("rejects invalid reshape settings %#", (reshape) => {
    expect(
      boardDocumentSchema.safeParse(
        document({ ...valid, pivot: undefined, reshape }),
      ).success,
    ).toBe(false);
  });
  it("rejects mixing aggregate pivot and reshape", () => {
    expect(
      boardDocumentSchema.safeParse(
        document({ ...valid, reshape: { kind: "melt", columns: ["1"] } }),
      ).success,
    ).toBe(false);
  });
  it("retains formatting, transformation and exact decimal strings", () => {
    expect(
      boardDocumentSchema.parse(document(valid)).nodes[0].data.table,
    ).toEqual(valid);
  });
  it.each([
    { ...valid, version: 2 },
    { ...valid, frozenColumns: 30 },
    { ...valid, columns: { "0": { decimals: -1 } } },
    { ...valid, columns: { "0": { format: "execute" } } },
    { ...valid, columns: { "0": { width: 1000000 } } },
    {
      ...valid,
      columns: { "0": { thresholds: [{ value: "bad", color: "red" }] } },
    },
    {
      ...valid,
      columns: {
        "0": { mappings: [{ value: null, text: "x", color: "url(x)" }] },
      },
    },
    {
      ...valid,
      filters: Array.from({ length: 21 }, () => ({
        column: "0",
        op: "eq",
        value: "1",
      })),
    },
  ])("rejects invalid or unbounded settings %#", (table) => {
    expect(boardDocumentSchema.safeParse(document(table)).success).toBe(false);
  });
});
