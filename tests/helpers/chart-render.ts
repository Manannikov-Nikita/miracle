import { act } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { mountChart } from "./chart-view";

type Chart = Awaited<ReturnType<typeof mountChart>>;
type Props = Parameters<typeof mountChart>[0];

/** Supply layout signals that jsdom lacks, including the first measured frame. */
export function mountBoardChart() {
  let chart: Chart | undefined;
  let width: number, height: number;
  const observers = new Set<ResizeObserverCallback>();
  beforeEach(() => {
    width = 700;
    height = 360;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      () => width,
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      () => height,
    );
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
  });
  afterEach(async () => {
    await chart?.unmount();
    chart = undefined;
    observers.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  return {
    get host() {
      if (!chart) throw Error("Render a chart first");
      return chart.host;
    },
    async render(props: Omit<Props, "label">) {
      const next = { ...props, label: "Диаграмма" };
      if (chart) await chart.render(next);
      else chart = await mountChart(next);
    },
    resize(w: number, h: number) {
      width = w;
      height = h;
      return act(async () => {
        const entries = [
          { contentRect: { width, height } },
        ] as ResizeObserverEntry[];
        for (const notify of observers) notify(entries, {} as ResizeObserver);
      });
    },
  };
}

export function textNodes(root: Element, selector: string) {
  return Array.from(
    root.querySelectorAll(selector),
    (el) => el.firstChild?.textContent ?? "",
  );
}
