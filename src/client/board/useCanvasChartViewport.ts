import { useContext, useLayoutEffect, useState, type RefObject } from "react";

import { CanvasChartDetailContext } from "./board-chart-overview";

type Watcher = {
  observer: IntersectionObserver;
  targets: Map<Element, (near: boolean) => void>;
};

const canvases = new WeakMap<Element, Watcher>();

// One observer per canvas, including when two boards are open side by side.
// XYFlow's translated/scaled viewport remains the observed node's ancestor.
function watch(
  root: Element,
  element: Element,
  change: (near: boolean) => void,
) {
  let watcher = canvases.get(root);
  if (!watcher) {
    const targets: Watcher["targets"] = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          targets.get(entry.target)?.(entry.isIntersecting);
      },
      { root, rootMargin: "200px" },
    );
    watcher = { observer, targets };
    canvases.set(root, watcher);
  }
  watcher.targets.set(element, change);
  watcher.observer.observe(element);
  return () => {
    watcher.targets.delete(element);
    watcher.observer.unobserve(element);
    if (!watcher.targets.size) {
      watcher.observer.disconnect();
      canvases.delete(root);
    }
  };
}

export function useCanvasChartViewport(
  content: RefObject<HTMLDivElement | null>,
  sharedCanvasChart: boolean,
  eager: boolean,
  scope: string,
) {
  const detail = useContext(CanvasChartDetailContext);
  const restore = detail.phase === "restore" ? detail : undefined;
  const [promoted, setPromoted] = useState<typeof detail>();
  const [visitedScope, setVisitedScope] = useState<string | null>(
    eager ? scope : null,
  );
  useLayoutEffect(() => {
    const body = content.current;
    if (!sharedCanvasChart) {
      body?.removeAttribute("data-chart-away");
      return;
    }
    const root = body?.closest(".react-flow");
    if (!body || !root || typeof IntersectionObserver !== "function") {
      setVisitedScope(scope);
      if (restore) setPromoted(restore);
      return;
    }
    // Re-observe after a zoom-in. Last frame's intersection can belong to the
    // fit-to-board camera and would promote every previously visible chart.
    return watch(root, body, (near) => {
      body.toggleAttribute("data-chart-away", !near);
      if (near) {
        setVisitedScope(scope);
        if (restore) setPromoted(restore);
      }
    });
  }, [content, scope, sharedCanvasChart, restore]);
  useLayoutEffect(() => {
    if (eager) setVisitedScope(scope);
  }, [eager, scope]);
  // An offscreen visit never unmounts a running chart, drops hidden series,
  // repeats its snapshot request, or changes the active keyboard/legend target.
  return {
    mount:
      !sharedCanvasChart ||
      eager ||
      visitedScope === scope ||
      typeof IntersectionObserver !== "function",
    overview:
      sharedCanvasChart &&
      (detail.phase === "overview" ||
        (detail.phase === "restore" &&
          typeof IntersectionObserver === "function" &&
          promoted !== detail)),
  };
}
