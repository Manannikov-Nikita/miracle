import { describe, expect, it } from "vitest";
import { chartSeries } from "../src/client/board/model";
import { chartSpecSchema } from "../src/shared/board-schema";
import {
  chartSeriesColorKey,
  unfinishedPeriodRule,
} from "../src/shared/chart-appearance";
import type { ChartSpec, Cell } from "../src/shared/types";

const columns = [
  { id: "x", name: "Period", type: "Date" },
  { id: "v", name: "Units", type: "Float64" },
  { id: "g", name: "Group", type: "String" },
  { id: "flag", name: "Closed", type: "Nullable(Bool)" },
  { id: "exact", name: "Reference", type: "Decimal(25,2)" },
];
const rows: Cell[][] = [
  ["2026-03-01", 3, "A", false, "9007199254740992.10"],
  ["2026-01-01", 1, "A", true, "9007199254740992.12"],
  ["2026-02-01", -2, "B", null, "9007199254740992.11"],
];
const keyA = chartSeriesColorKey("v", "g", "A");
const chart: ChartSpec = {
  kind: "bar",
  x: "x",
  y: ["v"],
  series: "g",
  sort: "asc",
  legend: true,
  seriesStyles: { [keyA]: { color: "#114477", opacity: 0.4 } },
  markRules: [
    {
      when: { field: "column", columnId: "flag", op: "eq", value: false },
      style: { pattern: "dots", opacity: 0 },
    },
    { when: { field: "value", op: "lt", value: 0 }, style: { borderWidth: 0 } },
    {
      seriesKey: keyA,
      when: { field: "x", op: "gt", value: "2026-02-01" },
      style: { pattern: "diagonal" },
    },
    {
      when: {
        field: "column",
        columnId: "exact",
        op: "gt",
        value: "9007199254740992.11",
      },
      style: { pattern: "crosshatch" },
    },
    {
      when: { field: "column", columnId: "flag", op: "eq", value: null },
      style: { borderStyle: "dotted" },
    },
    {
      when: { field: "column", columnId: "removed", op: "ne", value: "x" },
      style: { borderWidth: 8 },
    },
  ],
};
describe("conditional chart marks", () => {
  it("keeps empty styles visually inert while editing or resetting a rule", () => {
    const baseline = {
      ...chart,
      seriesStyles: undefined,
      markRules: undefined,
    };
    expect(
      chartSeries(columns, rows, {
        ...baseline,
        seriesStyles: { [keyA]: {} },
        markRules: [{ when: { field: "position", op: "last" }, style: {} }],
      }),
    ).toEqual(chartSeries(columns, rows, baseline));
  });
  it.each(["bar", "area", "line", "composed", "heatmap", "sparkline"] as const)(
    "resolves %s after sorting, using typed input rows, stable series keys and independent property priority",
    (kind) => {
      const [a, b] = chartSeries(columns, rows, {
        ...chart,
        kind,
        stacked: true,
      });
      expect(a.seriesStyle).toEqual(chart.seriesStyles![keyA]);
      expect(a.pointStyles?.[0]).toEqual({
        color: "#114477",
        opacity: 0.4,
        pattern: "crosshatch",
      });
      const march = a.data.findIndex(([x]) => x === "2026-03-01");
      expect(a.pointStyles?.[march]).toEqual({
        color: "#114477",
        opacity: 0,
        pattern: "diagonal",
      });
      const feb = b.data.findIndex(([x]) => x === "2026-02-01");
      expect(b.pointStyles?.[feb]).toEqual({
        borderWidth: 0,
        borderStyle: "dotted",
      });
      expect(b.seriesStyle).toBeUndefined();
    },
  );
  it("moves the unfinished period when data refreshes and respects the shared sorted axis", () => {
    const spec = { ...chart, markRules: [unfinishedPeriodRule] };
    const [a, b] = chartSeries(columns, rows, spec);
    expect(a.pointStyles?.[1]).toMatchObject(unfinishedPeriodRule.style);
    expect(b.pointStyles).toBeUndefined();
    const next = chartSeries(
      columns,
      [...rows, ["2026-04-01", 42, "B", false, "0"]],
      spec,
    );
    expect(next[0].pointStyles).toBeUndefined();
    expect(next[1].pointStyles?.[1]).toEqual(unfinishedPeriodRule.style);
    expect(
      chartSeries(columns, rows, { ...spec, sort: "desc" })[0].pointStyles?.[1],
    ).toMatchObject(unfinishedPeriodRule.style);
  });
  it("selects tied rightmost scatter observations independently of input order and null X", () => {
    const [s] = chartSeries(
      [{ ...columns[0], type: "Float64" }, columns[1]],
      [
        [7, 2],
        [null, 4],
        [2, 8],
        [7, 5],
      ],
      {
        kind: "scatter",
        x: "x",
        y: ["v"],
        legend: false,
        markRules: [unfinishedPeriodRule],
      },
    );
    expect(s.pointStyles?.flatMap((style, i) => (style ? [i] : []))).toEqual([
      0, 3,
    ]);
  });
  it("uses bin edges and frequencies on histograms and ignores observation-level conditions", () => {
    const [s] = chartSeries(columns, rows, {
      ...chart,
      kind: "histogram",
      x: "v",
      y: [],
      series: undefined,
      binCount: 2,
      markRules: [
        {
          when: { field: "x", op: "lt", value: 0 },
          style: { borderStyle: "dashed" },
        },
        {
          when: { field: "value", op: "eq", value: 2 },
          style: { opacity: 0.2 },
        },
        {
          when: { field: "column", columnId: "flag", op: "ne", value: true },
          style: { borderWidth: 8 },
        },
        { when: { field: "position", op: "last" }, style: { pattern: "dots" } },
      ],
    });
    expect(s.pointStyles).toEqual([
      { borderStyle: "dashed" },
      { opacity: 0.2, pattern: "dots" },
    ]);
  });
  it("rejects invalid paint, malformed selectors and oversized rule lists on save", () => {
    expect(chartSpecSchema.parse(chart)).toEqual(chart);
    for (const invalid of [
      { style: { pattern: "url(anything)" } },
      { style: { opacity: -0.1 } },
      { style: { borderWidth: 9 } },
      { style: { borderColor: "blue" } },
      { style: { fill: "red" } },
      { when: { field: "column", op: "eq", value: 0 } },
      { when: { field: "position", op: "latest" } },
      { when: { field: "value", op: "gt", value: [1] } },
    ])
      expect(
        chartSpecSchema.safeParse({
          ...chart,
          markRules: [{ ...unfinishedPeriodRule, ...invalid }],
        }).success,
      ).toBe(false);
    expect(
      chartSpecSchema.safeParse({
        ...chart,
        markRules: Array(33).fill(unfinishedPeriodRule),
      }).success,
    ).toBe(false);
  });
});
