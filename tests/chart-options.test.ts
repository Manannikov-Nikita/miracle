import { describe, expect, it } from "vitest";
import {
  chartOptions,
  formatChartNumber,
} from "../src/client/board/chartOptions";
import type { ChartSpec } from "../src/shared/types";
import { boardDocumentSchema } from "../src/server/validation";

const columns = [
  { id: "day", name: "Дата", type: "Date" },
  { id: "visits", name: "Визиты", type: "Int64" },
  { id: "revenue", name: "Выручка", type: "Float64" },
];
const spec: ChartSpec = {
  kind: "line",
  x: "day",
  y: ["revenue", "visits"],
  legend: true,
};

describe("chart presentation", () => {
  it("accepts compact chart settings and retains legacy labels when validating a saved board", () => {
    const document = {
      schemaVersion: 1,
      nodes: [
        {
          id: "n",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: {
            kind: "note",
            title: "Chart",
            chart: {
              ...spec,
              numberFormat: "compact",
              xLabel: "Legacy",
              legendPosition: "right",
              legendAlign: "end",
            },
          },
        },
      ],
      edges: [],
    };
    expect(boardDocumentSchema.parse(document)).toEqual(document);
  });

  it("derives both axis names from selected columns even in legacy charts", () => {
    const option = chartOptions(
      columns,
      {
        ...spec,
        xLabel: "Старая X",
        yLabel: "Старая Y",
      },
      [],
    );
    expect(option.xAxis.name).toBe("Дата");
    expect(option.yAxis.name).toBe("Выручка, Визиты");
    expect(option.yAxis.nameLocation).toBe("middle");
    expect(option.yAxis.nameRotate).toBe(90);
    expect(option.yAxis.nameMoveOverlap).toBe(true);
    expect(option.grid.outerBoundsContain).toBe("all");
  });

  it("preserves the top centered legend for saved charts without new settings", () => {
    const option = chartOptions(columns, spec, []);
    expect(option.legend).toMatchObject({
      type: "scroll",
      orient: "horizontal",
      left: "center",
      top: 6,
    });
  });

  it.each(["top", "bottom", "left", "right"] as const)(
    "reserves a separate strip for the %s legend and releases it when hidden",
    (legendPosition) => {
      const option = chartOptions(columns, { ...spec, legendPosition }, []);
      const hidden = chartOptions(
        columns,
        { ...spec, legendPosition, legend: false },
        [],
      );
      expect(option.legend.orient).toBe(
        legendPosition === "left" || legendPosition === "right"
          ? "vertical"
          : "horizontal",
      );
      expect(option.grid[legendPosition]).toBeGreaterThan(
        hidden.grid[legendPosition],
      );
      expect(hidden.legend.show).toBe(false);
      expect(option.legend.tooltip.show).toBe(true);
    },
  );

  it.each(["start", "center", "end"] as const)(
    "aligns legends at the %s of their strip",
    (legendAlign) => {
      const horizontal = chartOptions(columns, { ...spec, legendAlign }, []);
      const vertical = chartOptions(
        columns,
        { ...spec, legendPosition: "right", legendAlign },
        [],
      );
      expect(horizontal.legend.left).toBe(
        legendAlign === "start"
          ? 8
          : legendAlign === "center"
            ? "center"
            : "auto",
      );
      expect(horizontal.legend.right).toBe(legendAlign === "end" ? 8 : "auto");
      expect(vertical.legend.top).toBe(
        legendAlign === "start"
          ? 8
          : legendAlign === "center"
            ? "middle"
            : "auto",
      );
      expect(vertical.legend.bottom).toBe(legendAlign === "end" ? 8 : "auto");
    },
  );

  it.each([
    [34100, "34.1k"],
    [-34100, "-34.1k"],
    [0, "0"],
    [-0, "0"],
    [12.34, "12.3"],
    [0.5, "0.5"],
    [0.0123, "0.0123"],
    [0.0000001, "0.0000001"],
    [999.94, "999.9"],
    [999.95, "1k"],
    [999950, "1M"],
    [1000000000, "1G"],
    [2500000000000, "2.5T"],
  ])("formats compact %s as %s", (value, expected) => {
    expect(formatChartNumber(value, "compact")).toBe(expected);
  });

  it("preserves existing numeric formats", () => {
    expect(formatChartNumber(12.3456789, "auto")).toBe("12,345679");
    expect(formatChartNumber(12.6, "integer")).toBe("13");
    expect(formatChartNumber(12.345, "decimal")).toBe("12,35");
    expect(formatChartNumber(0.341, "percent")).toBe("34,1%");
  });

  it("formats Y ticks and tooltip numbers while preserving date and category text", () => {
    const option = chartOptions(
      columns,
      { ...spec, numberFormat: "compact" },
      [],
    );
    expect(option.yAxis.axisLabel.formatter(34100)).toBe("34.1k");
    expect(option.xAxis.axisLabel.formatter).toBeUndefined();
    expect(option.tooltip.valueFormatter(34100)).toBe("34.1k");
    expect(option.tooltip.valueFormatter("2026-10-22")).toBe("2026-10-22");
    expect(option.tooltip.valueFormatter("34100")).toBe("34100");
    expect(option.tooltip.valueFormatter(["2026-10-22", 34100, null])).toBe(
      "2026-10-22, 34.1k, —",
    );
  });

  it("formats numeric scatter X ticks and both tooltip coordinates", () => {
    const option = chartOptions(
      columns,
      {
        ...spec,
        kind: "scatter",
        x: "visits",
        numberFormat: "compact",
      },
      [],
    );
    expect(option.xAxis.axisLabel.formatter?.(34100)).toBe("34.1k");
    expect(option.tooltip.valueFormatter([34100, -2500000])).toBe(
      "34.1k, -2.5M",
    );
  });
});
