// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mountChart } from "./helpers/chart-view";
import {
  categoryText,
  metricText,
} from "../src/client/board/chart-kit/compact-plot";
import type { Cell, ChartSpec, Column } from "../src/shared/types";
import type { TableSpec } from "../src/shared/tableTypes";
import { createTableSpec } from "../src/client/board/tableModel";
import { chartSeries } from "../src/client/board/model";
import {
  chartTableData,
  normalizeChartSpec,
  tableChartSeries,
} from "../src/client/board/chartTableModel";

const columns: Column[] = [
  { id: "category", name: "Category", type: "String" },
  { id: "amount", name: "Amount", type: "Decimal(18, 4)" },
  { id: "group", name: "Group", type: "String" },
  { id: "other", name: "Other", type: "Int64" },
];
const spec: ChartSpec = {
  kind: "bar",
  x: "category",
  y: ["amount"],
  series: "group",
  legend: true,
};

describe("charts built from table data", () => {
  let view: Awaited<ReturnType<typeof mountChart>> | undefined;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(700);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
  });
  afterEach(async () => {
    await view?.unmount();
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function draw(
    table: ReturnType<typeof chartTableData>,
    saved: ChartSpec,
  ) {
    const props = {
      columns: table.columns,
      spec: saved,
      series: tableChartSeries(table, saved),
      label: "Revenue",
    };
    if (view) await view.render(props);
    else view = await mountChart(props);
    return view.host;
  }
  async function inspect(host: Element, key: string) {
    const svg = host.querySelector('svg[role="img"]')!;
    await act(async () => {
      svg.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    return host.querySelector('[role="tooltip"]')!;
  }

  it("uses the filtered, sorted, ordered, visible table columns and display names", () => {
    const table = chartTableData(
      columns,
      [
        ["A", "1.2300", "one", 4],
        ["B", "2.5", "two", 5],
        ["C", "3.75", "one", 6],
      ],
      {
        ...createTableSpec(columns),
        filters: [{ column: "group", op: "eq", value: "one" }],
        sort: { column: "amount", direction: "desc" },
        columns: { amount: { label: "Revenue" }, other: { hidden: true } },
        order: ["group", "amount", "category"],
      },
    );
    expect(table.columns.map(({ id, name }) => [id, name])).toEqual([
      ["group", "Group"],
      ["amount", "Revenue"],
      ["category", "Category"],
    ]);
    expect(table.rows).toEqual([
      ["one", "3.75", "C"],
      ["one", "1.2300", "A"],
    ]);
    const series = tableChartSeries(table, spec);
    expect(series[0].data).toEqual([
      ["C", 3.75],
      ["A", 1.23],
    ]);
    expect(series[0].name).toBe("Revenue · one");
  });

  it.each(["aggregate", "melt", "pivot"] as const)(
    "builds plots from the %s table shape",
    (kind) => {
      const base = createTableSpec(columns);
      const settings: TableSpec =
        kind === "aggregate"
          ? {
              ...base,
              pivot: {
                row: "category",
                column: "group",
                value: "amount",
                aggregate: "sum",
              },
            }
          : kind === "melt"
            ? {
                ...base,
                reshape: { kind: "melt", columns: ["amount", "other"] },
              }
            : {
                ...base,
                reshape: {
                  kind: "pivot",
                  rows: ["category"],
                  column: "group",
                  value: "amount",
                },
              };
      const inputColumns = columns;
      settings.sourceSchema = createTableSpec(inputColumns).sourceSchema;
      const table = chartTableData(
        inputColumns,
        [
          ["A", "1.25", "one", 4],
          ["B", "2.5", "two", 5],
        ],
        settings,
      );
      const normalized = normalizeChartSpec(table.columns, spec);
      const series = tableChartSeries(table, normalized);
      expect(series[0].data).toEqual(
        kind === "melt"
          ? [
              ["A", 1.25],
              ["A", 4],
            ]
          : [
              ["A", 1.25],
              ["B", null],
            ],
      );
      expect(normalized.y[0]).not.toBe("amount");
      if (kind !== "melt") expect(normalized.series).toBeUndefined();
    },
  );

  it("honors legacy visibleColumns and retains an intentionally empty selection", () => {
    expect(
      chartTableData(columns, [], undefined, [
        "category",
        "amount",
      ]).columns.map((c) => c.id),
    ).toEqual(["category", "amount"]);
    expect(chartTableData(columns, [], undefined, []).columns).toEqual([]);
  });

  it("repairs only missing chart references and preserves chart appearance and valid choices", () => {
    const visible = [columns[0], columns[1]];
    const saved: ChartSpec = {
      ...spec,
      x: "gone",
      y: ["gone", "amount"],
      orientation: "horizontal",
      palette: "warm",
      sort: "desc",
      showLabels: true,
    };
    expect(normalizeChartSpec(visible, saved)).toEqual({
      ...saved,
      x: "category",
      y: ["amount"],
      series: undefined,
    });
    expect(normalizeChartSpec(visible, { ...saved, y: ["gone"] }).y).toEqual([
      "amount",
    ]);
    expect(normalizeChartSpec(visible, { ...saved, y: [] }).y).toEqual([]);
    const invalidScatter = { ...spec, kind: "scatter" as const };
    expect(normalizeChartSpec(visible, invalidScatter).x).toBe("category");
    expect(() =>
      tableChartSeries(
        chartTableData(visible, [["text", "1"]]),
        normalizeChartSpec(visible, invalidScatter),
      ),
    ).toThrow(/числовой/);
    expect(
      normalizeChartSpec(visible, { ...invalidScatter, x: "gone" }).x,
    ).toBe("amount");
  });

  it("formats labels and tooltip values without replacing raw geometry or merging mapped groups", async () => {
    const table = chartTableData(
      columns,
      [
        ["A", "1.2300", "one", 1],
        ["B", "2.5000", "two", 2],
      ],
      {
        ...createTableSpec(columns),
        columns: {
          category: {
            mappings: [
              { value: "A", text: "Same" },
              { value: "B", text: "Same" },
            ],
          },
          group: {
            mappings: [
              { value: "one", text: "Mapped" },
              { value: "two", text: "Mapped" },
            ],
          },
          amount: {
            label: "Revenue",
            format: "currency",
            currency: "EUR",
            decimals: 2,
          },
        },
      },
    );
    const series = tableChartSeries(table, spec);
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.name)).toEqual([
      "Revenue · Mapped",
      "Revenue · Mapped",
    ]);
    expect(series.map((s) => s.data)).toEqual([[["A", 1.23]], [["B", 2.5]]]);
    expect(new Set(series.map((s) => s.colorKey)).size).toBe(2);
    const host = await draw(table, { ...spec, showLabels: true });
    expect(host.querySelectorAll(".bk-category-tick title")).toHaveLength(2);
    expect(
      [...host.querySelectorAll(".bk-category-tick title")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Same", "Same"]);
    expect(host.querySelector(".bk-value")?.textContent).toBe("€1.23");
    expect((await inspect(host, "End")).textContent).toContain("€2.50");
  });

  it("retains exact raw auto display and mapped nulls through sorted sparse stacks", () => {
    const table = chartTableData(
      columns,
      [
        ["B", "2.5000", "one", 1],
        ["A", null, "two", 2],
      ],
      {
        ...createTableSpec(columns),
        columns: { amount: { nullText: "Missing" } },
      },
    );
    const next = {
      ...spec,
      kind: "area" as const,
      stacked: true,
      sort: "asc" as const,
    };
    const series = tableChartSeries(table, next);
    expect(series[0].data).toEqual([
      ["A", null],
      ["B", 2.5],
    ]);
    expect(metricText(series[0], 0, next.numberFormat)).toBe("Missing");
    expect(metricText(series[0], 1, next.numberFormat)).toBe("2.5000");
  });

  it("formats scatter coordinates and per-cell colors without changing positions", async () => {
    const table = chartTableData(columns, [["A", "1.25", "one", 4]], {
      ...createTableSpec(columns),
      columns: {
        amount: {
          format: "percent",
          decimals: 1,
          display: "color-text",
          thresholds: [{ value: "1", color: "red" }],
        },
        other: { prefix: "x=" },
      },
    });
    const next = { ...spec, kind: "scatter" as const, x: "other" };
    const series = tableChartSeries(table, next);
    expect(series[0].data).toEqual([[4, 1.25]]);
    const host = await draw(table, next);
    expect(host.querySelector('circle[fill="#ef9c9c"]')).toBeTruthy();
    const tooltip = await inspect(host, "Home");
    expect(tooltip.textContent).toContain("x=4");
    expect(tooltip.textContent).toContain("125.0%");
  });

  it("escapes table-authored labels inside HTML chart tooltips", async () => {
    const table = chartTableData(columns, [["<img src=x>", "1", "one", 1]], {
      ...createTableSpec(columns),
      columns: { amount: { mappings: [{ value: "1", text: "<script>&" }] } },
    });
    const tooltip = await inspect(await draw(table, spec), "Home");
    expect(tooltip.textContent).toContain("<img src=x>");
    expect(tooltip.textContent).toContain("<script>&");
    expect(tooltip.querySelector("img, script")).toBeNull();
  });

  it("keeps chart numeric safety checks after table formatting", () => {
    const table = chartTableData(
      columns,
      [["A", "9007199254740993", "one", 1]],
      {
        ...createTableSpec(columns),
        columns: {
          amount: { mappings: [{ value: "9007199254740993", text: "Small" }] },
        },
      },
    );
    expect(() => tableChartSeries(table, spec)).toThrow(/точност/);
  });

  it("keeps chart number formatting unless a table format or matching mapping overrides it", async () => {
    const next = {
      ...spec,
      numberFormat: "percent" as const,
      showLabels: true,
    };
    for (const [settings, expected] of [
      [{}, "12,5%"],
      [{ format: "currency", currency: "EUR", decimals: 2 }, "€0.13"],
      [{ mappings: [{ value: "0.125", text: "Mapped" }] }, "Mapped"],
      [{ mappings: [{ value: "unmatched", text: "Ignored" }] }, "12,5%"],
    ] as const) {
      const table = chartTableData(columns, [["A", "0.125", "one", 1]], {
        ...createTableSpec(columns),
        columns: {
          amount: structuredClone(settings) as TableSpec["columns"][string],
        },
      });
      const host = await draw(table, next);
      expect(host.querySelector(".bk-value")?.textContent).toBe(expected);
      expect((await inspect(host, "Home")).textContent).toContain(expected);
    }
  });

  it("renders mapped categories and preserves independent legend controls for identical mapped group names", async () => {
    const table = chartTableData(
      columns,
      [
        ["A", "1", "one", 1],
        ["B", "2", "two", 2],
      ],
      {
        ...createTableSpec(columns),
        columns: {
          category: { mappings: [{ value: "A", text: "First category" }] },
          group: {
            mappings: [
              { value: "one", text: "Mapped" },
              { value: "two", text: "Mapped" },
            ],
          },
        },
      },
    );
    const host = await draw(table, spec);
    expect(host.querySelector(".bk-category-tick title")?.textContent).toBe(
      "First category",
    );
    const buttons = [
      ...host.querySelectorAll<HTMLButtonElement>(".bk-legend button"),
    ];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Amount · Mapped",
      "Amount · Mapped",
    ]);
    await act(async () => buttons[0].click());
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
    ]);
    expect(host.querySelectorAll(".bk-bar")).toHaveLength(1);
  });

  it("leaves the plain chart series contract unchanged", () => {
    const series = chartSeries(columns, [["A", "1.2300", "one", 1]], spec);
    expect(series[0]).not.toHaveProperty("displayData");
    expect(categoryText(series[0], 0)).toBe("A");
    expect(metricText(series[0], 0, spec.numberFormat)).toBe("1,23");
  });
});
