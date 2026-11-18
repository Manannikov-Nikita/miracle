// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import MatrixPlot from "../src/client/board/chart-kit/MatrixPlot";
import TrendPlot from "../src/client/board/chart-kit/TrendPlot";
import type { ChartPlotProps } from "../src/client/board/chart-kit/plot-types";
import { trendLine } from "../src/client/board/chart-kit/bklit/trend-line";

let host: HTMLElement;
let root: Root;
const props: ChartPlotProps = {
  label: "Динамика",
  colors: ["#e0f0ff", "#1da0ff"],
  columns: [],
  spec: { kind: "heatmap", x: "period", y: ["value"], legend: true },
  series: [
    {
      name: "Север",
      xCategories: ["Q1", "Q2", "Q3"],
      data: [
        ["Q1", -30],
        ["Q2", 0],
        ["Q3", null],
      ],
      displayData: [
        { x: "I", value: "−30 шт." },
        { x: "II", value: "0 шт." },
        { x: "III", value: "пусто" },
      ],
    },
    { name: "Юг", data: [["Q2", 100]] },
  ],
};
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(500);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const tooltipText = () => host.querySelector('[role="tooltip"]')?.textContent;
async function key(key: string) {
  await act(async () => {
    host
      .querySelector("svg")!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
it("draws the whole heat matrix, differentiates missing cells and zero, and reads formatted values with the keyboard", async () => {
  await act(async () => root.render(createElement(MatrixPlot, props)));
  const rects = [...host.querySelectorAll(".matrix-column rect")];
  expect(rects).toHaveLength(6);
  expect(rects[1].getAttribute("fill")).toBe("none");
  expect(rects[2].getAttribute("fill")).toBe(props.colors[0]);
  expect(Number(rects[2].getAttribute("fill-opacity"))).toBeGreaterThan(
    Number(rects[0].getAttribute("fill-opacity")),
  );
  expect(host.querySelector(".matrix-scale")?.textContent).toBe("-30100");
  await key("ArrowRight");
  expect(tooltipText()).toContain("0 шт.");
  expect(host.querySelector(".matrix-focus")).toBeTruthy();
  expect(host.querySelector("svg")?.getAttribute("aria-describedby")).toBe(
    host.querySelector('[role="tooltip"]')?.id,
  );
  expect(host.querySelector(".matrix-plot mask")).toBeTruthy();
  await key("ArrowDown");
  expect(tooltipText()).toContain("Q2Юг100");
  await key("Home");
  expect(tooltipText()).toContain("Q1Юг—");
  await act(async () =>
    root.render(
      createElement(MatrixPlot, {
        ...props,
        spec: {
          ...props.spec,
          legend: false,
          showXAxis: false,
          showYAxis: false,
        },
      }),
    ),
  );
  expect(host.querySelector(".matrix-scale, .matrix-tick")).toBeNull();
});
it("renders independent trend rows and exposes formatted category and null values", async () => {
  await act(async () =>
    root.render(
      createElement(TrendPlot, {
        ...props,
        spec: { ...props.spec, kind: "sparkline" },
      }),
    ),
  );
  expect(host.querySelectorAll(".trend-line")).toHaveLength(2);
  expect(
    host.querySelectorAll(".trend-row")[1].querySelector("circle"),
  ).toBeTruthy();
  await key("End");
  expect(tooltipText()).toBe("IIIСеверпусто");
  await key("Home");
  expect(tooltipText()).toBe("IСевер−30 шт.");
  expect(host.querySelector("svg")?.getAttribute("aria-describedby")).toBe(
    host.querySelector('[role="tooltip"]')?.id,
  );
  expect(
    host.querySelector(".trend-row[data-active] .trend-marker"),
  ).toBeTruthy();
  expect(host.querySelector('.trend-scroll [role="tooltip"]')).toBeNull();
  await key("Escape");
  expect(tooltipText()).toBeUndefined();
  expect(host.querySelector(".trend-row[data-active]")).toBeNull();
});
it("centres flat curves, breaks the path at nulls and supports signed Float64 extrema", () => {
  expect(trendLine([Number.MAX_VALUE], 200, 60).points).toEqual([
    { x: 100, y: 30 },
  ]);
  const { points, path } = trendLine(
    [-Number.MAX_VALUE, 0, null, Number.MAX_VALUE],
    200,
    60,
  );
  expect(points.map((p) => p.y)).toEqual([55, 30, NaN, 5]);
  expect(path.match(/M/g)).toHaveLength(2);
});

it("keeps a densely populated row visible at subpixel column widths", async () => {
  const data: [string, number][] = Array.from({ length: 600 }, (_, i) => [
    String(i),
    i,
  ]);
  await act(async () =>
    root.render(
      createElement(MatrixPlot, {
        ...props,
        series: [{ name: "Измерение", data }],
      }),
    ),
  );
  const cell = host.querySelector(".matrix-column rect")!;
  expect(Number(cell.getAttribute("width"))).toBeLessThan(1);
  expect(Number(cell.getAttribute("height"))).toBeGreaterThan(12);
});

it.each(["sparkline", "heatmap"] as const)(
  "retargets the existing %s focus overlay while pointer scrubbing and snaps it on a keyboard command",
  async (kind) => {
    await act(async () =>
      root.render(
        createElement(kind === "heatmap" ? MatrixPlot : TrendPlot, {
          ...props,
          spec: { ...props.spec, kind },
        }),
      ),
    );
    const svg = host.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 300),
    );
    const mark = kind === "heatmap" ? ".matrix-focus" : ".trend-marker";
    const gotoPoint = async (index: number) => {
      const cell = host
        .querySelectorAll(".matrix-column")
        [index]?.querySelector("rect");
      const x = cell
        ? Number(cell.getAttribute("x")) +
          Number(cell.getAttribute("width")) / 2
        : 5 + 245 * index;
      const y = cell
        ? Number(cell.getAttribute("y")) +
          Number(cell.getAttribute("height")) / 2
        : 30;
      await act(async () => {
        svg.dispatchEvent(
          new MouseEvent("pointermove", {
            bubbles: true,
            clientX: x,
            clientY: y,
          }),
        );
      });
    };
    await gotoPoint(0);
    const overlay = host.querySelector<SVGGraphicsElement>(mark)!;
    const initial = overlay.style.transform;
    await gotoPoint(1);
    expect(host.querySelector(mark)).toBe(overlay);
    expect(overlay.style.transform).not.toBe(initial);
    expect(overlay.closest("[data-pointer]")).toBeTruthy();
    expect(tooltipText()).toContain("0 шт.");
    await key("Home");
    expect(overlay.closest("[data-pointer]")).toBeNull();
    expect(
      host.querySelector('[role="tooltip"]')?.hasAttribute("data-motion"),
    ).toBe(false);
    expect(overlay.style.transform).toBe(initial);
    expect(tooltipText()).toContain("−30 шт.");
  },
);

it("multiplies tile intensity by style opacity and preserves missing tiles", async () => {
  await act(async () =>
    root.render(
      createElement(MatrixPlot, {
        ...props,
        series: [
          {
            ...props.series[0],
            seriesStyle: {
              color: "#336699",
              borderColor: "#222222",
              borderWidth: 2,
              opacity: 0.5,
            },
            pointStyles: [
              undefined,
              {
                color: "#ee9933",
                opacity: 0.25,
                borderColor: "#113355",
                borderStyle: "dotted",
                pattern: "dots",
              },
            ],
          },
        ],
      }),
    ),
  );
  const [low, high, missing] = host.querySelectorAll(".matrix-column rect");
  expect(low.getAttribute("fill")).toBe("#336699");
  expect(low.getAttribute("fill-opacity")).toBe("0.1");
  expect(high.getAttribute("fill")).toBe(
    `url(#${host.querySelector("pattern")!.id})`,
  );
  expect(high.getAttribute("stroke")).toBe("#113355");
  expect(high.getAttribute("stroke-dasharray")).toBe("1 3");
  expect(high.getAttribute("fill-opacity")).toBe("0.25");
  expect(missing.getAttribute("fill")).toBe("none");
  expect(missing.getAttribute("stroke")).toBe("currentColor");
  await key("ArrowRight");
  expect(
    host.querySelector<HTMLElement>(".chart-tooltip-swatch")?.style
      .backgroundColor,
  ).toBe("rgb(238, 153, 51)");
});

it("styles an incoming sparkline segment and marker while sharing its geometry with keyboard focus", async () => {
  await act(async () =>
    root.render(
      createElement(TrendPlot, {
        ...props,
        spec: { ...props.spec, kind: "sparkline" },
        series: [
          {
            name: "Север",
            data: [
              ["A", 0],
              ["B", 2],
              ["C", 1],
              ["D", null],
              ["E", 3],
            ],
            seriesStyle: { color: "#336699" },
            pointStyles: [
              undefined,
              {
                color: "#ee9933",
                pattern: "dots",
                borderColor: "#3300aa",
                borderStyle: "dashed",
                borderWidth: 2,
                opacity: 0.5,
              },
            ],
          },
        ],
      }),
    ),
  );
  const lines = host.querySelectorAll(".trend-context .trend-line");
  expect(lines).toHaveLength(2);
  const pattern = `url(#${host.querySelector("pattern")!.id})`;
  expect(lines[0].getAttribute("stroke")).toBe(pattern);
  expect(lines[0].getAttribute("stroke-dasharray")).toBe("5 3");
  expect(lines[0].hasAttribute("pathLength")).toBe(false);
  expect(lines[0].previousElementSibling?.getAttribute("stroke")).toBe(
    "#3300aa",
  );
  expect(lines[1].getAttribute("stroke")).toBe("#336699");
  const [matched, single] = host.querySelectorAll(".trend-context circle");
  expect(matched.getAttribute("fill")).toBe(pattern);
  expect(single.getAttribute("fill")).toBe("#336699");
  await key("ArrowRight");
  expect(host.querySelector("use")?.getAttribute("href")).toBe(
    `#${lines[0].parentElement!.id}`,
  );
  expect(
    host.querySelector(".trend-marker circle:last-child")?.getAttribute("fill"),
  ).toBe(pattern);
  expect(
    host.querySelector<HTMLElement>(".chart-tooltip-swatch")?.style
      .backgroundColor,
  ).toBe("rgb(238, 153, 51)");
  await key("ArrowRight");
  await key("ArrowRight");
  expect(tooltipText()).toContain("—");
  expect(host.querySelector(".trend-marker")).toBeNull();
});

it("keeps a legacy sparkline and isolated marks in its series color while inspection uses the table color", async () => {
  await act(async () =>
    root.render(
      createElement(TrendPlot, {
        ...props,
        spec: { ...props.spec, kind: "sparkline" },
        series: [
          {
            name: "Север",
            data: [
              ["A", 0],
              ["B", 2],
              ["C", null],
              ["D", 1],
            ],
            displayData: [
              { x: "A", value: "0", color: "#ee9933" },
              { x: "B", value: "2" },
              { x: "C", value: "—" },
              { x: "D", value: "1", color: "#ee9933" },
            ],
          },
        ],
      }),
    ),
  );
  const line = host.querySelector(".trend-line")!;
  expect(line.getAttribute("stroke")).toBe(props.colors[0]);
  expect(line.getAttribute("pathLength")).toBe("1");
  expect(
    host.querySelector(".trend-context circle")?.getAttribute("fill"),
  ).toBe(props.colors[0]);
  await key("End");
  expect(
    host.querySelector(".trend-marker circle:last-child")?.getAttribute("fill"),
  ).toBe("#ee9933");
});
