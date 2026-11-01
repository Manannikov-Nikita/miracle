// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type ReactFlowInstance } from "@xyflow/react";
import BoardFlow from "../src/client/board/BoardFlow";
import ArtifactNode, {
  type ArtifactFlowNode,
} from "../src/client/board/ArtifactNode";
import type { BoardNodeData } from "../src/shared/types";

// Keep ArtifactNode, ResultView and XYFlow's native wheel handling real.
// Only the remote snapshot and canvas drawing need substitutes in jsdom.
const failure = vi.hoisted(() => ({ stage: "" }));
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
  return { getResultRows: () => load("snapshot"), api: () => load("data") };
});
vi.mock("echarts", () => ({
  init(host: HTMLElement) {
    host.appendChild(document.createElement("canvas"));
    return {
      setOption() {
        if (failure.stage === "renderer")
          throw new Error("Renderer failed\n".repeat(100));
      },
      resize() {},
      dispose() {
        host.replaceChildren();
      },
    };
  },
}));

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

  async function render(data: BoardNodeData, gestureScope = "board") {
    await act(async () =>
      root.render(
        createElement(BoardFlow, {
          gestureScope,
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
            },
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
    await wheel(".board-chart canvas", 0, 60);
    expect(flow.getViewport()).toEqual({ x: 0, y: -50, zoom: 1 });
    await wheel(".board-chart canvas", 40, -20);
    expect(flow.getViewport()).toEqual({ x: -20, y: -40, zoom: 1 });
  });

  it("allows trackpad pinch zoom over a chart", async () => {
    await render(chart);
    await wheel(".board-chart canvas", 0, -20, true);
    expect(flow.getViewport().zoom).toBeGreaterThan(1);
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
