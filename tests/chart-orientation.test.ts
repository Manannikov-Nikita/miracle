// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { Cell, ChartSpec } from "../src/shared/types";
import { chartSeries } from "../src/client/board/model";
import { mountBoardChart, textNodes } from "./helpers/chart-render";

const columns = [
  { id: "category", name: "Категория", type: "String" },
  { id: "value", name: "Выручка", type: "Float64" },
];
const horizontal: ChartSpec = {
  kind: "bar",
  orientation: "horizontal",
  x: "category",
  y: ["value"],
  legend: true,
};
const rows: Cell[][] = [
  ["B", 34100],
  ["A", -12000],
  ["C", null],
];
const chart = mountBoardChart();
const render = (spec: ChartSpec) =>
  chart.render({ spec, columns, series: chartSeries(columns, rows, spec) });

describe("horizontal charts", () => {
  it.each([
    ["none", ["B", "A", "C"]],
    ["asc", ["A", "B", "C"]],
    ["desc", ["C", "B", "A"]],
  ] as const)(
    "lays out %s categories top to bottom and leaves null gaps",
    async (sort, expected) => {
      await render({ ...horizontal, sort });
      const labels = [...chart.host.querySelectorAll("svg text")].filter((t) =>
        ["A", "B", "C"].includes(t.firstChild?.textContent ?? ""),
      );
      expect(labels.map((el) => el.firstChild?.textContent)).toEqual(expected);
      const ys = labels.map((el) => Number(el.getAttribute("y")));
      expect(ys[0]).toBeLessThan(ys[1]);
      expect(ys[1]).toBeLessThan(ys[2]);
      const bars = [...chart.host.querySelectorAll(".bk-bar")];
      expect(bars).toHaveLength(2);
      const negative = bars[sort === "asc" ? 0 : 1],
        positive = bars[sort === "asc" ? 1 : 0];
      expect(
        Number(negative.getAttribute("x")) +
          Number(negative.getAttribute("width")),
      ).toBeCloseTo(Number(positive.getAttribute("x")), 6);
      expect(textNodes(chart.host, ".bk-axis-name")).toEqual([
        "Выручка",
        "Категория",
      ]);
    },
  );
  it("keeps category text and formats both numeric ticks and the focused value", async () => {
    await render({ ...horizontal, numberFormat: "compact" });
    expect(
      textNodes(chart.host, "svg text").some((text) => text.endsWith("k")),
    ).toBe(true);
    await act(async () =>
      chart.host
        .querySelector("svg[role=img]")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
        ),
    );
    expect(textNodes(chart.host, ".chart-tooltip-heading strong")).toEqual([
      "B",
    ]);
    expect(textNodes(chart.host, ".chart-tooltip-value")).toEqual(["34.1k"]);
  });
  it.each(["line", "area"] as const)(
    "retains a saved horizontal preference while %s uses ordinary axes",
    async (kind) => {
      await render({ ...horizontal, kind });
      expect(textNodes(chart.host, ".bk-axis-name")).toEqual([
        "Категория",
        "Выручка",
      ]);
      await render(horizontal);
      expect(textNodes(chart.host, ".bk-axis-name")).toEqual([
        "Выручка",
        "Категория",
      ]);
    },
  );
  it.each([undefined, "vertical"] as const)(
    "keeps ordinary column charts vertical with orientation %s",
    async (orientation) => {
      await render({ ...horizontal, orientation });
      const [first, second] = Array.from(
        chart.host.querySelectorAll(".bk-bar"),
      );
      expect(Number(first.getAttribute("x"))).toBeLessThan(
        Number(second.getAttribute("x")),
      );
      expect(
        Number(first.getAttribute("y")) + Number(first.getAttribute("height")),
      ).toBeCloseTo(Number(second.getAttribute("y")), 6);
    },
  );
});
