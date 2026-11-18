// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChartCanvas from "../src/client/board/ChartCanvas";
import { chartOptions } from "../src/client/board/chartOptions";
import { chartSeries } from "../src/client/board/model";
import type { Column } from "../src/shared/types";

type ChartOption = ReturnType<typeof chartOptions>;
type Selection = Record<string, boolean>;
type LegendEvent = { selected: Selection };
type LegendHandler = (event: LegendEvent) => void;
type Instance = {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  setOption: ReturnType<typeof vi.fn>;
  getOption: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  listeners: Map<string, Set<LegendHandler>>;
};
const renderer = vi.hoisted(() => ({ instances: [] as Instance[] }));
vi.mock("echarts", () => ({
  init() {
    const listeners = new Map<string, Set<LegendHandler>>();
    const chart: Instance = {
      listeners,
      on: vi.fn((event: string, handler: LegendHandler) => {
        const handlers = listeners.get(event) ?? new Set();
        handlers.add(handler);
        listeners.set(event, handlers);
      }),
      off: vi.fn((event: string, handler: LegendHandler) => {
        listeners.get(event)?.delete(handler);
      }),
      setOption: vi.fn(),
      getOption: vi.fn(() => ({ legend: [{ scrollDataIndex: 0 }] })),
      resize: vi.fn(),
      dispose: vi.fn(),
      clear: vi.fn(),
    };
    renderer.instances.push(chart);
    return chart;
  },
  getInstanceByDom: vi.fn(),
}));

const columns: Column[] = [
  { id: "category", name: "Категория", type: "String" },
  { id: "amount", name: "Сумма", type: "Float64" },
  { id: "group", name: "Группа", type: "String" },
];
function optionFor(groups = ["one", "two"]) {
  const spec = {
    kind: "bar" as const,
    x: "category",
    y: ["amount"],
    series: "group",
    stacked: true,
    legend: true,
  };
  return chartOptions(
    columns,
    spec,
    chartSeries(
      columns,
      groups.map((group, i) => ["A", i + 1, group]),
      spec,
    ),
  );
}
function builderFor(option: ChartOption, backgroundColor = "transparent") {
  return vi.fn((selected: Selection) => ({
    ...option,
    backgroundColor,
    legend: { ...option.legend, selected: { ...selected } },
  }));
}

describe("chart legend-dependent options", () => {
  let host: HTMLDivElement;
  let root: Root;
  let observers: Set<ResizeObserverCallback>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    renderer.instances = [];
    observers = new Set();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe() {
          observers.add(this.callback);
        }
        disconnect() {
          observers.delete(this.callback);
        }
      },
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(
    option: ChartOption,
    createOption?: (selected: Selection) => ChartOption,
    loading = false,
  ) {
    await act(async () =>
      root.render(
        createElement(ChartCanvas, {
          option,
          createOption,
          label: "График",
          loading,
        }),
      ),
    );
  }
  function chart() {
    return renderer.instances[0];
  }
  function applied() {
    return chart().setOption.mock.lastCall![0] as ChartOption & {
      legend: { selected?: Selection };
    };
  }
  async function select(selected: Selection) {
    await act(async () => {
      for (const handler of chart().listeners.get("legendselectchanged") ?? [])
        handler({ selected });
    });
  }

  it("rebuilds with the legend selection and subscribes only once across settings updates", async () => {
    const option = optionFor();
    const builder = builderFor(option);
    await render(option, builder);
    const [one, two] = option.series.map((series) => series.name);
    const selected = { [one]: false, [two]: true };
    chart().getOption.mockReturnValue({ legend: [{ scrollDataIndex: 8 }] });
    await select(selected);
    expect(builder).toHaveBeenLastCalledWith(selected);
    expect(applied().legend.selected).toEqual(selected);
    expect(applied().legend).toHaveProperty("scrollDataIndex", 8);
    selected[one] = true;
    expect(applied().legend.selected?.[one]).toBe(false);
    await render({ ...option, animation: false }, builder);
    expect(applied().legend.selected?.[one]).toBe(false);
    expect(
      chart().on.mock.calls.filter(
        ([event]) => event === "legendselectchanged",
      ),
    ).toHaveLength(1);
    expect(renderer.instances).toHaveLength(1);
  });

  it("retains hidden series across new options, drops removed names and shows new series", async () => {
    const initial = optionFor();
    await render(initial, builderFor(initial));
    const [one, two] = initial.series.map((series) => series.name);
    await select({ [one]: false, [two]: false });
    const next = optionFor(["one", "three"]);
    const builder = builderFor(next);
    await render(next, builder);
    const selected = builder.mock.lastCall![0];
    expect(selected[one]).toBe(false);
    expect(selected).not.toHaveProperty(two);
    expect(selected[next.series[1].name]).not.toBe(false);
    expect(applied().legend.selected?.[one]).toBe(false);
    expect(applied().series.map((series) => series.name)).toEqual(
      next.series.map((series) => series.name),
    );
  });

  it("uses a replaced builder instead of the closure captured when the chart mounted", async () => {
    const option = optionFor();
    const first = builderFor(option, "first");
    await render(option, first);
    const second = builderFor(option, "second");
    await render(option, second);
    const firstCalls = first.mock.calls.length;
    const selected = { [option.series[0].name]: false };
    await select(selected);
    expect(second).toHaveBeenLastCalledWith(selected);
    expect(first).toHaveBeenCalledTimes(firstCalls);
    expect(applied().backgroundColor).toBe("second");
  });

  it("supports enabling and disabling legend rebuilding without remounting the chart", async () => {
    const option = optionFor();
    await render(option);
    const builder = builderFor(option);
    await render(option, builder);
    const selected = { [option.series[0].name]: false };
    await select(selected);
    expect(builder).toHaveBeenLastCalledWith(selected);
    await render(option);
    const calls = builder.mock.calls.length;
    await select({ [option.series[0].name]: true });
    expect(builder).toHaveBeenCalledTimes(calls);
    expect(renderer.instances).toHaveLength(1);
  });

  it("keeps selection on resize, detaches the handler and ignores events after disposal", async () => {
    const option = optionFor();
    const builder = builderFor(option);
    await render(option, builder);
    const selected = { [option.series[0].name]: false };
    await select(selected);
    const handler = [...chart().listeners.get("legendselectchanged")!][0];
    const beforeResize = chart().setOption.mock.calls.length;
    await act(async () => {
      for (const callback of observers) callback([], {} as ResizeObserver);
    });
    expect(chart().resize).toHaveBeenCalledTimes(1);
    expect(chart().setOption).toHaveBeenCalledTimes(beforeResize);
    expect(applied().legend.selected).toEqual(selected);
    await act(async () => root.render(null));
    expect(chart().off).toHaveBeenCalledWith("legendselectchanged", handler);
    expect(chart().dispose).toHaveBeenCalledTimes(1);
    expect(observers.size).toBe(0);
    const builderCalls = builder.mock.calls.length;
    await act(async () => handler({ selected: {} }));
    expect(builder).toHaveBeenCalledTimes(builderCalls);
    expect(chart().setOption).toHaveBeenCalledTimes(beforeResize);
  });

  it("keeps the native legend through a refresh, defers updates and replaces superseded data exactly once", async () => {
    const first = optionFor();
    const builder = builderFor(first);
    await render(first, builder);
    const hidden = first.series[0].name;
    await select({ [hidden]: false });
    chart().getOption.mockReturnValue({
      legend: [{ scrollDataIndex: 1, selected: { [hidden]: false } }],
    });
    const earlier = chart().setOption.mock.calls.length;
    await render(first, builder, true);
    expect(host.querySelector(".chart-skeleton")).toBeTruthy();
    expect(host.querySelector('[role="img"]')).toBeNull();
    expect(chart().clear).toHaveBeenCalledTimes(1);
    const stale = optionFor(["one", "stale"]);
    await render(stale, builderFor(stale), true);
    const latest = optionFor(["one", "final"]);
    const nextBuilder = builderFor(latest);
    await render(latest, nextBuilder, true);
    await act(async () => {
      for (const cb of observers) cb([], {} as ResizeObserver);
    });
    expect(chart().resize).not.toHaveBeenCalled();
    expect(chart().setOption).toHaveBeenCalledTimes(earlier);
    await render(latest, nextBuilder);
    expect(host.querySelector(".chart-skeleton")).toBeNull();
    expect(chart().resize).toHaveBeenCalledTimes(1);
    expect(chart().setOption).toHaveBeenCalledTimes(earlier + 1);
    expect(applied().legend.selected).toEqual({ [hidden]: false });
    expect(applied().legend).toHaveProperty("scrollDataIndex", 1);
    expect(applied().series.map((s) => s.name)).toEqual(
      latest.series.map((s) => s.name),
    );
    expect(applied().series[0]).toMatchObject({
      animation: true,
      animationDuration: 1100,
      animationDurationUpdate: 0,
    });
    await render(latest, nextBuilder, true);
    await act(async () => root.render(null));
    expect(chart().dispose).toHaveBeenCalledOnce();
    expect(chart().setOption).toHaveBeenCalledTimes(earlier + 1);
  });
  it.each(["vertical", "horizontal"] as const)(
    "anchors the %s loading stacks to zero for the visible series",
    async (orientation) => {
      const spec = {
        kind: "bar" as const,
        orientation,
        x: "category",
        y: ["amount"],
        series: "group",
        stacked: true,
        legend: true,
      };
      const rows = [
        ["A", 6, "gain"],
        ["A", -3, "loss"],
        ["B", 2, "gain"],
        ["B", -5, "loss"],
      ];
      const option = chartOptions(
        columns,
        spec,
        chartSeries(columns, rows, spec, (value) => ({
          text: String(value),
          color: typeof value === "number" && value < 0 ? "#e58d59" : undefined,
        })),
      );
      async function bounds(selected: Selection) {
        await render(option);
        chart().getOption.mockReturnValue({ legend: [{ selected }] });
        await render(option, undefined, true);
        const bars = host.querySelectorAll(
          '.chart-skeleton [data-skeleton-mark="bar"] rect',
        );
        expect(bars.length).toBeGreaterThan(0);
        const horizontal = orientation === "horizontal";
        return [...bars].map((bar) => {
          const start = parseFloat(bar.getAttribute(horizontal ? "x" : "y")!);
          const length = parseFloat(
            bar.getAttribute(horizontal ? "width" : "height")!,
          );
          return { start, end: start + length };
        });
      }
      const mixed = await bounds({});
      expect(mixed.some((b) => Math.abs(b.start - 50) < 0.001)).toBe(true);
      expect(mixed.some((b) => Math.abs(b.end - 50) < 0.001)).toBe(true);
      const [gain, loss] = option.series.map((s) => s.name);
      const negative = await bounds({ [gain]: false, [loss]: true });
      const positive = await bounds({ [gain]: true, [loss]: false });
      const fromStart = orientation === "horizontal" ? positive : negative;
      const fromEnd = orientation === "horizontal" ? negative : positive;
      for (const bar of fromStart) expect(bar.start).toBeCloseTo(0);
      for (const bar of fromEnd) expect(bar.end).toBeCloseTo(100);
    },
  );

  it("restores native selections even without a totals builder and skips reveal for reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const option = optionFor();
    await render(option, undefined, true);
    expect(chart().setOption).not.toHaveBeenCalled();
    await render(option);
    const hidden = option.series[0].name;
    chart().getOption.mockReturnValue({
      legend: [{ selected: { [hidden]: false } }],
    });
    await render(option, undefined, true);
    await render(option);
    expect(applied().legend.selected).toEqual({ [hidden]: false });
    expect(applied().animation).toBe(false);
    expect(applied().series[0]).not.toHaveProperty("animation", true);
  });
  it("shows a skeleton instead of the previous render error during retry and renders the replacement", async () => {
    const option = optionFor();
    await render(option);
    const failed = { ...option };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      chart().setOption.mockImplementationOnce(() => {
        throw Error("invalid previous rendering");
      });
      await render(failed);
      expect(host.querySelector('[role="alert"]')).toBeTruthy();
      await render(failed, undefined, true);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector(".chart-skeleton")).toBeTruthy();
      await render(optionFor(["replacement"]));
      expect(host.querySelector('[role="alert"], .chart-skeleton')).toBeNull();
      expect(host.querySelector('[role="img"]')).toBeTruthy();
    } finally {
      errors.mockRestore();
    }
  });
});
