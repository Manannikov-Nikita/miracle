// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getResultRows } from "../src/client/api";
import { type ReactFlowInstance } from "@xyflow/react";
import {
  BoardChartOverviewContext,
  isLargeChartBoard,
} from "../src/client/board/board-chart-overview";
import BoardFlow from "../src/client/board/BoardFlow";
import ArtifactNode, {
  type ArtifactFlowNode,
} from "../src/client/board/ArtifactNode";
import type { BoardNodeData } from "../src/shared/types";

// Keep ArtifactNode, ResultView and XYFlow's native wheel handling real.
// Fail the drawing step only for the error-detail scrolling case.
const failure = vi.hoisted(() => ({ stage: "" }));
const resultRenders = vi.hoisted(() => vi.fn());
vi.mock("../src/client/board/ResultView", async (load) => {
  const actual = await load<typeof import("../src/client/board/ResultView")>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      resultRenders(props.nodeId, useContext(BoardChartOverviewContext));
      return createElement(actual.default, props);
    },
  };
});
vi.mock("../src/client/api", () => {
  const snapshot = async () => ({
    result: {
      id: "snapshot",
      columns: [
        { id: "x", name: "X", type: "String" },
        { id: "y", name: "Y", type: "UInt64" },
      ],
      rowCount: 2,
      byteCount: 32,
      createdAt: "2026-11-01T00:00:00Z",
      source: { connectionId: "source", sql: "select x, y" },
    },
    rows: [
      ["A", 10],
      ["B", 20],
    ],
    offset: 0,
    total: 2,
  });
  const load = (stage: string) => {
    if (failure.stage === stage)
      return Promise.reject(new Error("Snapshot unavailable\n".repeat(100)));
    return snapshot();
  };
  return {
    getResultRows: vi.fn(() => load("snapshot")),
    api: () => load("data"),
  };
});
vi.mock(
  "../src/client/board/chart-kit/cartesian-geometry",
  async (original) => {
    const geometry =
      await original<
        typeof import("../src/client/board/chart-kit/cartesian-geometry")
      >();
    return {
      ...geometry,
      cartesianGeometry: (
        ...args: Parameters<typeof geometry.cartesianGeometry>
      ) => {
        if (failure.stage === "renderer")
          throw new Error("Renderer failed\n".repeat(100));
        return geometry.cartesianGeometry(...args);
      },
    };
  },
);

const nodeTypes = { artifact: ArtifactNode };
const chart: BoardNodeData = {
  kind: "result",
  title: "Chart",
  resultSetId: "snapshot",
  view: "chart",
  chart: { kind: "bar", x: "x", y: ["y"], legend: true },
};

describe("board trackpad scrolling", () => {
  let host: HTMLDivElement;
  let root: Root;
  let flow: ReactFlowInstance<ArtifactFlowNode>;

  beforeEach(() => {
    failure.stage = "";
    vi.mocked(getResultRows).mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON() {},
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value() {},
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(
    data: BoardNodeData,
    gestureScope = "board",
    extras: ArtifactFlowNode[] = [],
    selected = false,
    { largeChartBoard = false, zoom = 1 } = {},
  ) {
    await act(async () =>
      root.render(
        createElement(BoardFlow, {
          gestureScope,
          largeChartBoard,
          defaultViewport: { x: 0, y: 0, zoom },
          width: 1000,
          height: 800,
          nodeTypes,
          nodes: [
            {
              id: "block",
              type: "artifact",
              position: { x: 0, y: 0 },
              width: 400,
              height: 300,
              data,
              selected,
            },
            ...extras,
          ],
          panOnScroll: true,
          panOnDrag: [1, 2],
          zoomOnDoubleClick: false,
          onInit(instance) {
            flow = instance;
          },
        }),
      ),
    );
  }
  function installVisibilityObserver() {
    const watched = new Set<Element>();
    let callback: IntersectionObserverCallback;
    const disconnect = vi.fn();
    const makeObserver = vi.fn(function (
      this: Partial<IntersectionObserver>,
      handle: IntersectionObserverCallback,
    ) {
      callback = handle;
      this.observe = (element) => {
        watched.add(element);
      };
      this.unobserve = (element) => {
        watched.delete(element);
      };
      this.disconnect = disconnect;
    });
    vi.stubGlobal("IntersectionObserver", makeObserver);
    const notify = (target: Element, isIntersecting: boolean) => {
      expect(watched.has(target)).toBe(true);
      callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    };
    return { watched, makeObserver, disconnect, notify };
  }
  it("loads only nearby canvas charts, keeps their legend state on return and shares an observer", async () => {
    const observer = installVisibilityObserver();
    await render(chart, "board", [
      {
        id: "far",
        type: "artifact",
        position: { x: 6000, y: 5000 },
        width: 400,
        height: 300,
        data: chart,
      },
    ]);
    const bodies = host.querySelectorAll<HTMLElement>("[data-canvas-chart]");
    expect(bodies).toHaveLength(2);
    expect(observer.makeObserver).toHaveBeenCalledTimes(1);
    expect(observer.makeObserver).toHaveBeenCalledWith(expect.any(Function), {
      root: host.querySelector(".react-flow"),
      rootMargin: "200px",
    });
    expect(getResultRows).not.toHaveBeenCalled();
    expect(host.querySelector("article[aria-label=Chart]")).not.toBeNull();
    await act(async () => {
      observer.notify(bodies[0], true);
      observer.notify(bodies[1], false);
    });
    const legend =
      bodies[0].querySelector<HTMLButtonElement>(".bk-legend button")!;
    expect(legend.getAttribute("aria-pressed")).toBe("true");
    expect(bodies[1].querySelector(".board-chart")).toBeNull();
    await act(async () => legend.click());
    await act(async () => {
      observer.notify(bodies[0], false);
      observer.notify(bodies[1], true);
    });
    expect(getResultRows).toHaveBeenCalledTimes(2);
    expect(bodies[0].hasAttribute("data-chart-away")).toBe(true);
    await act(async () => observer.notify(bodies[0], true));
    expect(bodies[0].querySelector(".bk-legend button")).toBe(legend);
    expect(legend.getAttribute("aria-pressed")).toBe("false");
    expect(bodies[0].hasAttribute("data-chart-away")).toBe(false);
    expect(getResultRows).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    expect(observer.watched.size).toBe(0);
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("opens an unvisited selection immediately and keeps its data after deselection", async () => {
    installVisibilityObserver();
    await render(chart);
    expect(getResultRows).not.toHaveBeenCalled();
    await render(chart, "board", [], true);
    expect(host.querySelector(".bk-legend")).not.toBeNull();
    await render(chart);
    expect(host.querySelector(".bk-legend")).not.toBeNull();
    expect(getResultRows).toHaveBeenCalledOnce();
    await render({ ...chart, view: "table" });
    expect(host.querySelector(".board-table-scroll")).not.toBeNull();
    expect(getResultRows).toHaveBeenCalledOnce();
  });

  it("retains an already fetched table when it is switched to a chart outside the viewport", async () => {
    installVisibilityObserver();
    await render({ ...chart, view: "table" });
    expect(host.querySelector(".board-table-scroll")).not.toBeNull();
    await render(chart);
    expect(host.querySelector(".bk-legend")).not.toBeNull();
    expect(getResultRows).toHaveBeenCalledOnce();
  });
  it("counts only native chart results for the board overview threshold", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      type: "artifact" as const,
      position: { x: 0, y: i * 400 },
      data: chart,
    }));
    expect(
      isLargeChartBoard([
        ...nodes,
        { ...nodes[0], data: { ...chart, view: "table" } },
        { ...nodes[0], data: { ...chart, view: "custom" } },
        { ...nodes[0], data: { ...chart, resultSetId: undefined } },
        { ...nodes[0], data: { kind: "text", title: "Заметка" } },
      ]),
    ).toBe(false);
    expect(isLargeChartBoard([...nodes, { ...nodes[0], id: "21" }])).toBe(true);
  });
  it("starts at saved overview zoom, waits for fresh intersections on zoom-in and retains detail across pans", async () => {
    const observed = installVisibilityObserver();
    resultRenders.mockClear();
    const other: ArtifactFlowNode = {
      id: "far",
      type: "artifact",
      position: { x: 4000, y: 4000 },
      width: 400,
      height: 300,
      data: chart,
    };
    await render(chart, "dense", [other], true, {
      largeChartBoard: true,
      zoom: 0.4,
    });
    const [near, far] = [
      ...host.querySelectorAll<HTMLElement>("[data-canvas-chart]"),
    ];
    const mode = (body: Element) =>
      body.closest("article")!.hasAttribute("data-chart-overview");
    expect(mode(near)).toBe(true);
    expect(
      resultRenders.mock.calls
        .filter(([id]) => id === "block")
        .every(([, overview]) => overview === true),
    ).toBe(true);
    await act(async () => {
      observed.notify(near, true);
      observed.notify(far, true);
    });
    expect(mode(far)).toBe(true);
    const zoom = async (z: number) => {
      await act(async () => {
        await flow.setViewport({ x: 0, y: 0, zoom: z });
      });
    };
    await zoom(0.53);
    expect(mode(near)).toBe(true);
    await zoom(0.56);
    expect(mode(near)).toBe(true);
    expect(mode(far)).toBe(true);
    await act(async () => {
      observed.notify(near, true);
      observed.notify(far, false);
    });
    expect(mode(near)).toBe(false);
    expect(mode(far)).toBe(true);
    await act(async () => {
      observed.notify(near, false);
      observed.notify(far, true);
    });
    expect(mode(far)).toBe(false);
    expect(mode(near)).toBe(false);
    await zoom(0.47);
    expect(mode(near)).toBe(false);
    await zoom(0.45);
    expect(mode(near)).toBe(true);
    expect(mode(far)).toBe(true);
    expect(getResultRows).toHaveBeenCalledTimes(2);
    await render(chart, "sparse", [], true, { zoom: 0.3 });
    expect(mode(host.querySelector("[data-canvas-chart]")!)).toBe(false);
  });
  async function wheel(
    selector: string,
    deltaX: number,
    deltaY: number,
    ctrlKey = false,
  ) {
    const target = host.querySelector(selector);
    expect(target).not.toBeNull();
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX,
      deltaY,
      ctrlKey,
    });
    await act(async () => {
      target!.dispatchEvent(event);
    });
    return event;
  }

  it("continues vertical and diagonal board scrolling when the pointer crosses a chart", async () => {
    await render(chart);
    await wheel(".react-flow__pane", 0, 40);
    expect(flow.getViewport()).toEqual({ x: 0, y: -20, zoom: 1 });
    await wheel(".board-chart svg[role=img]", 0, 60);
    expect(flow.getViewport()).toEqual({ x: 0, y: -50, zoom: 1 });
    await wheel(".board-chart svg[role=img]", 40, -20);
    expect(flow.getViewport()).toEqual({ x: -20, y: -40, zoom: 1 });
  });

  it("allows trackpad pinch zoom over a chart", async () => {
    await render(chart);
    resultRenders.mockClear();
    await wheel(".board-chart svg[role=img]", 0, -20, true);
    expect(flow.getViewport().zoom).toBeGreaterThan(1);
    expect(resultRenders).not.toHaveBeenCalled();
  });

  it("keeps a board gesture moving when it crosses a table", async () => {
    await render({ ...chart, view: "table" });
    await wheel(".react-flow__pane", 0, 40);
    const event = await wheel(".board-table-scroll", 40, 60);
    expect(event.defaultPrevented).toBe(true);
    expect(flow.getViewport()).toEqual({ x: -20, y: -50, zoom: 1 });
    expect(host.querySelector(".board-table-scroll")!.scrollTop).toBe(0);
  });

  it("returns scrolling to the table after the board gesture ends", async () => {
    vi.useFakeTimers();
    try {
      await render({ ...chart, view: "table" });
      await wheel(".react-flow__pane", 0, 40);
      // A long gesture remains the board's while wheel events keep arriving.
      for (let i = 0; i < 4; i++) {
        await act(async () => vi.advanceTimersByTime(100));
        await wheel(".board-table-scroll", 0, 20);
      }
      expect(flow.getViewport()).toEqual({ x: 0, y: -60, zoom: 1 });
      await act(async () => vi.advanceTimersByTime(200));
      const event = await wheel(".board-table-scroll", 0, 60);
      expect(event.defaultPrevented).toBe(false);
      expect(flow.getViewport()).toEqual({ x: 0, y: -60, zoom: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["blur", "board change"])(
    "releases the board gesture on %s",
    async (reason) => {
      const table = { ...chart, view: "table" as const };
      await render(table);
      await wheel(".react-flow__pane", 0, 40);
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      else await render(table, "another-board");
      const event = await wheel(".board-table-scroll", 0, 60);
      expect(event.defaultPrevented).toBe(false);
      expect(flow.getViewport()).toEqual({ x: 0, y: -20, zoom: 1 });
      await wheel(".react-flow__pane", 0, 20);
      await wheel(".board-table-scroll", 0, 20);
      expect(flow.getViewport()).toEqual({ x: 0, y: -40, zoom: 1 });
    },
  );

  it("keeps pinch zoom working when its gesture crosses a table", async () => {
    await render({ ...chart, view: "table" });
    await wheel(".react-flow__pane", 0, -20, true);
    const zoom = flow.getViewport().zoom;
    await wheel(".board-table-scroll", 0, -20, true);
    expect(flow.getViewport().zoom).toBeGreaterThan(zoom);
  });

  it.each(["snapshot", "data", "validation", "renderer"])(
    "keeps expanded %s error details scrollable inside the chart block",
    async (stage) => {
      failure.stage = stage;
      if (stage === "renderer")
        vi.spyOn(console, "error").mockImplementation(() => {});
      await render(
        stage === "validation"
          ? { ...chart, chart: { ...chart.chart!, y: [] } }
          : chart,
      );
      const details = host.querySelector<HTMLDetailsElement>("details");
      expect(details).not.toBeNull();
      await act(async () => details!.querySelector("summary")!.click());
      expect(details!.open).toBe(true);
      const event = await wheel("details pre", 0, 60);
      expect(event.defaultPrevented).toBe(false);
      expect(flow.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
    },
  );

  it.each([
    ["table", { ...chart, view: "table" }, ".board-table-scroll"],
    ["note", { kind: "note", title: "Note", text: "Text" }, "textarea"],
  ] as const)(
    "leaves %s scrolling inside the block",
    async (_label, data, selector) => {
      await render(data);
      const event = await wheel(selector, 0, 60);
      expect(event.defaultPrevented).toBe(false);
      expect(flow.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
    },
  );
});
