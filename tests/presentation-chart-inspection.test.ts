// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Board, ChartSpec } from "../src/shared/types";
import PresentationShow from "../src/client/board/PresentationShow";

const spec: ChartSpec = {
  kind: "bar",
  legend: true,
  x: "month",
  y: ["amount"],
};
vi.mock("../src/client/board/ResultView", async () => {
  const { default: BoardChartPlot } =
    await import("../src/client/board/BoardChartPlot");
  return {
    default: ({ view }: { view: string }) =>
      view === "chart"
        ? createElement(BoardChartPlot, {
            spec,
            label: "Продажи",
            columns: [],
            series: [
              {
                name: "Сумма",
                data: [
                  ["Январь", 10],
                  ["Февраль", 20],
                ],
              },
            ],
          })
        : createElement(view === "custom" ? "iframe" : "button"),
  };
});
const board: Board = {
  id: "deck",
  name: "Отчёт",
  revision: 1,
  updatedAt: "2026-11-18",
  document: {
    schemaVersion: 1,
    kind: "presentation",
    slides: [
      { id: "one", title: "Результат", background: "#fff" },
      { id: "two", title: "План", background: "#fff" },
    ],
    edges: [],
    nodes: (["chart", "custom", "table"] as const).map((view, i) => ({
      id: view,
      slideId: "one",
      type: "artifact",
      position: { x: 30 + i * 300, y: 40 },
      width: 280,
      height: 180,
      data: { kind: "result", title: view, view, resultSetId: "result" },
    })),
  },
};
let host: HTMLDivElement, root: Root;
const onClose = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(PresentationShow, {
        board,
        initialSlideId: "one",
        onClose,
        trigger: host,
      }),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  onClose.mockClear();
});
const key = (target: Element, key: string) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const chart = () =>
  dialog().querySelector<SVGSVGElement>('[aria-label="Продажи"]')!;
it("keeps charts keyboard-inspectable, while static table and custom content stay inert", async () => {
  const plot = chart();
  const legend =
    dialog().querySelector<HTMLButtonElement>(".bk-legend button")!;
  expect(plot.closest("[inert]")).toBeNull();
  expect(plot.tabIndex).toBe(0);
  expect(legend.tabIndex).toBe(0);
  expect(
    dialog()
      .querySelector('article[aria-label="custom"] iframe')!
      .closest("[inert]"),
  ).toBeTruthy();
  expect(
    dialog()
      .querySelector('article[aria-label="table"] button')!
      .closest("[inert]"),
  ).toBeTruthy();
  await act(async () => {
    legend.click();
  });
  expect(legend.getAttribute("aria-pressed")).toBe("false");
  await act(async () => {
    legend.click();
  });
  await key(chart(), "Home");
  await key(chart(), "ArrowRight");
  expect(dialog().querySelector('[role="tooltip"]')?.textContent).toContain(
    "Февраль",
  );
  await key(chart(), "Escape");
  expect(dialog().querySelector('[role="tooltip"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await key(chart(), "Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
});
it("dismisses a tooltip from the slide controls and keeps normal slide navigation", async () => {
  await key(chart(), "Home");
  expect(dialog().querySelector('[role="tooltip"]')).toBeTruthy();
  await key(dialog(), "Escape");
  expect(dialog().querySelector('[role="tooltip"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await key(dialog(), "PageDown");
  expect(
    dialog().querySelector(".presentation-show-controls")?.textContent,
  ).toContain("План");
  await key(dialog(), "Home");
  expect(chart()).toBeTruthy();
});
