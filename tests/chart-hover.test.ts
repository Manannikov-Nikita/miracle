// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CartesianPlot from "../src/client/board/chart-kit/CartesianPlot";
import {
  focusColumns,
  keyboardFocus,
  pointerFocus,
} from "../src/client/board/chart-kit/cartesian-focus";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import { chartSeries } from "../src/client/board/model";
import type { Cell, ChartSpec } from "../src/shared/types";

const columns = [
  { id: "x", name: "Месяц", type: "String" },
  { id: "n", name: "Выручка", type: "Float64" },
  { id: "m", name: "План", type: "Float64" },
];
const rows: Cell[][] = [
  ["Янв", 12, 8],
  ["Фев", -20, 12],
  ["Мар", 0, null],
  ["Апр", 30, 15],
];
const base: ChartSpec = { kind: "bar", x: "x", y: ["n", "m"], legend: true };
function props(spec = base) {
  return {
    columns,
    spec,
    series: chartSeries(columns, rows, spec),
    colors: ["#84bdff", "#dba460"],
    label: "Отчёт",
  };
}
it.each(["horizontal", "vertical"] as const)(
  "selects the actual grouped %s bar, including negatives and zero",
  (orientation) => {
    const layout = cartesianGeometry(props({ ...base, orientation }), 460, 240);
    const data = focusColumns(layout);
    const active = data[1][0];
    expect(active.point.value).toBe(-20);
    const x = layout.horizontal ? (active.x + layout.zero) / 2 : active.x;
    const y = layout.horizontal ? active.y : (active.y + layout.zero) / 2;
    expect(pointerFocus(layout, data, x, y)).toEqual({
      category: 1,
      sample: 0,
    });
    expect(
      layout.horizontal ? active.x < layout.zero : active.y > layout.zero,
    ).toBe(true);
    expect(pointerFocus(layout, data, data[2][0].x, data[2][0].y)).toEqual({
      category: 2,
      sample: 0,
    });
    expect(pointerFocus(layout, data, 0, 0)).toBeNull();
  },
);
it("selects a line point crossing a column and keeps that series through keyboard navigation", () => {
  const layout = cartesianGeometry(
    props({ ...base, kind: "composed" }),
    460,
    240,
  );
  const data = focusColumns(layout);
  const line = data[3][1];
  expect(line.point.value).toBe(15);
  const selected = pointerFocus(layout, data, line.x, line.y);
  expect(selected).toEqual({ category: 3, sample: 1 });
  expect(keyboardFocus("Home", layout, data, selected)).toEqual({
    category: 0,
    sample: 1,
  });
  expect(keyboardFocus("ArrowDown", layout, data, selected)).toEqual({
    category: 3,
    sample: 0,
  });
  expect(keyboardFocus("Escape", layout, data, selected)).toBeNull();
});
describe("board chart inspection", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  it("keeps each composed series marker and the category chip mounted while scrubbing", async () => {
    const p = props({ ...base, kind: "composed" });
    await act(() => root.render(createElement(CartesianPlot, p)));
    const svg = host.querySelector("svg")!;
    await act(() => svg.focus());
    const markers = () => [...svg.querySelectorAll(".bk-focus-dot")];
    const initial = markers();
    expect(initial).toHaveLength(2);
    const chip = svg.querySelector(".bk-category-chip");
    const move = async (key: string) =>
      act(() => {
        svg.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    await move("ArrowRight");
    expect(markers()[0]).toBe(initial[0]);
    expect(markers()[1]).toBe(initial[1]);
    expect(svg.querySelector(".bk-category-chip")).toBe(chip);
    await move("ArrowRight");
    expect(markers()).toHaveLength(1);
    expect(markers()[0]).toBe(initial[0]);
    await move("End");
    expect(markers()).toHaveLength(2);
    expect(chip?.textContent).toBe("Апр");
  });

  it("exposes a focused label, formatted series and a value marker, then clears all emphasis", async () => {
    const p = props();
    p.series[0].displayData = rows.map((row) => ({
      x: String(row[0]),
      value: String(row[1]) + " ₽",
      color: "#eeddcc",
    }));
    await act(() => root.render(createElement(CartesianPlot, p)));
    const svg = host.querySelector("svg")!;
    await act(() => svg.focus());
    async function press(key: string) {
      await act(() => {
        svg.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }
    await press("ArrowRight");
    const tooltip = host.querySelector('[role="tooltip"]')!;
    expect(svg.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toContain("-20 ₽");
    expect(host.querySelector(".bk-category-chip")?.textContent).toBe("Фев");
    expect(host.querySelector(".bk-focus-dot")?.getAttribute("fill")).toBe(
      "#eeddcc",
    );
    expect(host.querySelector(".bk-marks")?.getAttribute("data-dimmed")).toBe(
      "true",
    );
    await press("Escape");
    expect(host.querySelector(".bk-category-chip")).toBeNull();
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(host.querySelector(".bk-marks")?.getAttribute("data-dimmed")).toBe(
      "false",
    );
  });
});
