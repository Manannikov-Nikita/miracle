// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import LineShapeContent from "../src/client/board/LineShapeContent";
import type { ShapeSpec } from "../src/shared/shapes";

let root: Root;
let host: HTMLDivElement;
let measure: (width: number, height: number) => void;
let disconnected: boolean;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  disconnected = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        measure = (width, height) =>
          callback(
            [{ contentRect: { width, height } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }
      observe() {}
      disconnect() {
        disconnected = true;
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

async function render(shape: ShapeSpec, width = 260, height = 40) {
  await act(async () =>
    root.render(createElement(LineShapeContent, { shape })),
  );
  await act(async () => measure(width, height));
}
function points(selector: string) {
  return host
    .querySelector(selector)!
    .getAttribute("points")!
    .split(" ")
    .map((point) => point.split(",").map(Number));
}

describe("standalone line shape rendering", () => {
  it("renders a visible unfilled line without text or connection controls", async () => {
    await render({ type: "line", fill: "#ff0000" });
    const line = host.querySelector(".board-line-shaft")!;
    expect(line.tagName.toLowerCase()).toBe("line");
    expect(line.getAttribute("fill")).toBe("none");
    expect(Number(line.getAttribute("x1"))).toBeLessThan(
      Number(line.getAttribute("x2")),
    );
    expect(line.getAttribute("y1")).toBe(line.getAttribute("y2"));
    expect(
      host.querySelector("polygon, textarea, input, .react-flow__handle"),
    ).toBeNull();
    expect(host.querySelector("svg")!.getAttribute("viewBox")).toBe(
      "0 0 260 40",
    );
  });

  it("provides a narrow stroke hit target without making the whole frame clickable", async () => {
    await render({ type: "line", lineEnd: "arrow" });
    const hit = host.querySelector(".board-line-hit")!;
    expect(hit).not.toBeNull();
    expect(Number(hit.getAttribute("x1"))).toBeCloseTo(5.6);
    expect(Number(hit.getAttribute("x2"))).toBeCloseTo(254.4);
    expect(hit.getAttribute("stroke")).toBe("transparent");
    expect(hit.getAttribute("pointer-events")).toBe("stroke");
    expect(
      host.querySelector(".board-line-shaft")!.getAttribute("pointer-events"),
    ).toBe("visiblePainted");
    expect(
      host.querySelector(".board-line-arrow")!.getAttribute("pointer-events"),
    ).toBe("visiblePainted");
  });

  it.each([
    ["vertical", 0, 1],
    ["diagonal-down", 1, 1],
    ["diagonal-up", 1, -1],
  ] as const)(
    "draws %s in the requested direction",
    async (lineDirection, dx, dy) => {
      await render({ type: "line", lineDirection }, 320, 120);
      const line = host.querySelector(".board-line-shaft")!;
      const difference = (axis: string) =>
        Number(line.getAttribute(`${axis}2`)) -
        Number(line.getAttribute(`${axis}1`));
      expect(Math.sign(difference("x"))).toBe(dx);
      expect(Math.sign(difference("y"))).toBe(dy);
    },
  );

  it("keeps both arrowheads solid while applying dashes, stroke and opacity to the line", async () => {
    await render({
      type: "line",
      lineStart: "arrow",
      lineEnd: "arrow",
      stroke: "#123456",
      strokeWidth: 3,
      strokeStyle: "dashed",
      opacity: 0.4,
    });
    const line = host.querySelector(".board-line-shaft")!;
    expect(line.getAttribute("stroke")).toBe("#123456");
    expect(line.getAttribute("stroke-width")).toBe("3");
    expect(line.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(line.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(
      host.querySelector<HTMLElement>(".board-shape-content")!.style.opacity,
    ).toBe("0.4");
    expect(host.querySelectorAll("polygon")).toHaveLength(2);
    for (const arrow of host.querySelectorAll("polygon")) {
      expect(arrow.getAttribute("fill")).toBe("#123456");
      expect(arrow.getAttribute("stroke-dasharray")).toBeNull();
    }
    const start = points(".board-line-arrow-start");
    const end = points(".board-line-arrow-end");
    expect(start[0][0]).toBeLessThan(start[1][0]);
    expect(end[0][0]).toBeGreaterThan(end[1][0]);
    // The shaft stops at each head's base, keeping its blunt stroke cap from
    // sticking out beside the triangle's tip.
    expect(Number(line.getAttribute("x1"))).toBeGreaterThan(start[0][0]);
    expect(Number(line.getAttribute("x2"))).toBeLessThan(end[0][0]);
  });

  it("uses unscaled dimensions so resizing a wide node does not stretch its arrowhead", async () => {
    await render({ type: "line", lineEnd: "arrow" }, 260, 40);
    const before = points(".board-line-arrow-end");
    const dimensions = (vertices: number[][]) => [
      Math.max(...vertices.map(([x]) => x)) -
        Math.min(...vertices.map(([x]) => x)),
      Math.max(...vertices.map(([, y]) => y)) -
        Math.min(...vertices.map(([, y]) => y)),
    ];
    await act(async () => measure(780, 120));
    expect(host.querySelector("svg")!.getAttribute("viewBox")).toBe(
      "0 0 780 120",
    );
    const after = dimensions(points(".board-line-arrow-end"));
    const expected = dimensions(before);
    expect(after[0]).toBeCloseTo(expected[0]);
    expect(after[1]).toBeCloseTo(expected[1]);
  });

  it("keeps thick diagonal arrowheads within a small node and disconnects its observer", async () => {
    await render(
      {
        type: "line",
        lineDirection: "diagonal-up",
        lineStart: "arrow",
        lineEnd: "arrow",
        strokeWidth: 12,
      },
      40,
      40,
    );
    for (const selector of [".board-line-arrow-start", ".board-line-arrow-end"])
      for (const point of points(selector))
        for (const value of point) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(40);
        }
    await act(async () => root.render(null));
    expect(disconnected).toBe(true);
  });

  it("gives each line its own animated work gradient", async () => {
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement(LineShapeContent, { shape: { type: "line" } }),
          createElement(LineShapeContent, {
            shape: { type: "line", lineEnd: "arrow" },
          }),
        ),
      ),
    );
    const gradients = [...host.querySelectorAll(".board-shape-work-gradient")];
    expect(gradients).toHaveLength(2);
    expect(new Set(gradients.map((element) => element.id)).size).toBe(2);
    for (const line of host.querySelectorAll<SVGElement>(".board-line-shaft"))
      expect(line.style.getPropertyValue("--agent-shape-stroke")).toContain(
        "url(#",
      );
  });
});
