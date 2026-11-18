// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import CartesianPlot from "../src/client/board/chart-kit/CartesianPlot";
import { chartSeries } from "../src/client/board/model";
import type { ChartPlotProps } from "../src/client/board/chart-kit/plot-types";
import type { Cell, ChartSpec } from "../src/shared/types";

const columns = [
  { id: "x", name: "Месяц", type: "String" },
  { id: "a", name: "Шт.", type: "Float64" },
  { id: "b", name: "План", type: "Float64" },
  { id: "group", name: "Регион", type: "String" },
];
const data: Cell[][] = [
  ["I", 12, 30, "А"],
  ["I", 6, 8, "Б"],
  ["I", -3, null, "В"],
  ["II", -4, 7, "А"],
  ["II", -9, null, "Б"],
  ["III", null, null, "А"],
  ["IV", 0, null, "А"],
];
const base: ChartSpec = {
  kind: "bar",
  stacked: true,
  x: "x",
  y: ["a", "b"],
  series: "group",
  legend: true,
  showLabels: true,
};
const colors = [
  "#31114a",
  "#0696ab",
  "#8538c1",
  "#069b56",
  "#f79030",
  "#5c49b6",
];
function inputs(spec: ChartSpec): ChartPlotProps {
  return {
    spec,
    columns,
    colors,
    label: "Динамика",
    series: chartSeries(columns, data, spec, (value, col, role) => ({
      text: role === "metric" ? `${value ?? "—"} шт.` : String(value),
      color: role === "metric" && value === 12 ? "#221133" : undefined,
    })),
  };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (props: ChartPlotProps) =>
  act(async () => root.render(createElement(CartesianPlot, props)));
const totals = () =>
  [...host.querySelectorAll(".bk-stack-total")].map((el) => el.textContent);
const key = (key: string) =>
  act(async () => {
    host
      .querySelector('svg[role="img"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
  });

it.each(["vertical", "horizontal"] as const)(
  "draws signed %s bars with square joins, rounded tips and independently formatted totals",
  async (orientation) => {
    const p = inputs({ ...base, orientation });
    await render(p);
    const g = cartesianGeometry(p, 460, 240);
    const first = host.querySelector(".bk-stack-category")!;
    expect(totals().sort()).toEqual(["15", "38", "-13", "7", "0"].sort());
    expect(first.querySelectorAll('rect.bk-bar[rx="0"]')).toHaveLength(2);
    expect(first.querySelectorAll("path.bk-bar")).toHaveLength(3);
    expect(first.querySelector(".bk-bar")?.getAttribute("fill")).toBe(
      "#221133",
    );
    const label = first.querySelector(".bk-inside")!;
    expect(label.querySelector("title")?.textContent ?? label.textContent).toBe(
      "12 шт.",
    );
    expect(first.querySelectorAll(".bk-stack-total")).toHaveLength(2);
    const net = g.stackTotals.find(
      (t) => t.metricId === "a" && t.category === 0,
    )!;
    const painted = [...first.querySelectorAll(".bk-stack-total")].find(
      (t) => t.textContent === "15",
    )!;
    if (orientation === "horizontal")
      expect(Number(painted.getAttribute("x"))).toBeGreaterThan(net.x);
    else expect(Number(painted.getAttribute("y"))).toBeLessThan(net.y);
    // Every sparse segment in this category animates together from the shared zero axis.
    expect(first.getAttribute("style")).toContain(`${g.zero}px`);
    expect(first.querySelector(".bk-bar")?.getAttribute("style")).toBeNull();
    await render({
      ...p,
      spec: { ...p.spec, showTotals: false, labelPosition: "outside" },
    });
    expect(totals()).toEqual([]);
    expect(host.querySelector(".bk-inside")).toBeNull();
    expect(
      [...host.querySelectorAll(".bk-stack-value")].map((n) => n.textContent),
    ).toContain("12 шт.");
    await render({ ...p, spec: { ...p.spec, showLabels: false } });
    expect(host.querySelector(".bk-stack-value")).toBeNull();
    expect(totals()).toContain("15");
  },
);

it("inspects real segments, maintains the native value and updates totals when a breakdown is removed", async () => {
  const p = inputs({ ...base, y: ["a"] });
  await render(p);
  await key("Home");
  const selected = host.querySelector(".bk-active-bar")!;
  expect(selected?.getAttribute("fill")).toBe("#221133");
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain(
    "12 шт.",
  );
  await key("ArrowDown");
  expect(host.querySelector(".bk-active-bar")).not.toBe(selected);
  expect(host.querySelector(".bk-focus-dot")).toBeTruthy();
  await key("Escape");
  expect(host.querySelector('[role="tooltip"],.bk-active-bar')).toBeNull();
  const visible = p.series.filter((s) => s.name.endsWith("А"));
  await render({ ...p, series: visible, colors: [colors[0]] });
  expect(totals().sort()).toEqual(["12", "-4", "0"].sort());
  expect(host.querySelector(".bk-stack-category path.bk-bar")).toBeTruthy();
});

it.each(["vertical", "horizontal"] as const)(
  "keeps labels apart for dense %s stacks with many metrics, shortened totals and coincident extents",
  async (orientation) => {
    const spec: ChartSpec = {
      ...base,
      orientation,
      labelPosition: "outside",
      y: Array.from({ length: 8 }, (_, i) => `m${i}`),
    };
    const series = spec.y.flatMap((metricId, i) =>
      [0, 1].map((j) => ({
        metricId,
        name: `${metricId} · ${j}`,
        data: Array.from(
          { length: 4 },
          (_, k) =>
            [
              String(k),
              (k % 2 === 0 ? 1 : -1) * (1234567891 + i + j * 100),
            ] as [string, number],
        ),
      })),
    );
    await render({
      columns,
      spec,
      series,
      colors: series.map(() => "#487cc2"),
      label: "Dense",
    });
    const labels = [
      ...host.querySelectorAll<SVGTextElement>(
        ".bk-stack-total,.bk-stack-value",
      ),
    ];
    expect(host.querySelector(".bk-stack-total")).toBeTruthy();
    if (orientation === "vertical")
      expect(host.querySelector(".bk-stack-total title")).toBeTruthy();
    const boxes = labels.map((el) => {
      const x = Number(el.getAttribute("x")),
        y = Number(el.getAttribute("y"));
      const width = (el.firstChild?.textContent?.length ?? 0) * 6.2;
      const align = el.getAttribute("text-anchor");
      const left =
        x - (align === "end" ? width : align === "middle" ? width / 2 : 0);
      return { left, right: left + width, top: y - 5, bottom: y + 5 };
    });
    for (let i = 0; i < boxes.length; i++)
      for (let j = 0; j < i; j++) {
        const a = boxes[i],
          b = boxes[j];
        expect(
          a.right <= b.left ||
            a.left >= b.right ||
            a.bottom <= b.top ||
            a.top >= b.bottom,
        ).toBe(true);
      }
  },
);
