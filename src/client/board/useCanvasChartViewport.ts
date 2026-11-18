import { useLayoutEffect, useState, type RefObject } from "react";

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
  const [visitedScope, setVisitedScope] = useState<string | null>(
    eager ? scope : null,
  );
  useLayoutEffect(() => {
    if (!sharedCanvasChart) return;
    const body = content.current;
    const root = body?.closest(".react-flow");
    if (!body || !root || typeof IntersectionObserver !== "function") {
      setVisitedScope(scope);
      return;
    }
    const stop = watch(root, body, (near) => {
      body.toggleAttribute("data-chart-away", !near);
      if (near) setVisitedScope(scope);
    });
    return () => {
      stop();
      body.removeAttribute("data-chart-away");
    };
  }, [content, scope, sharedCanvasChart]);
  useLayoutEffect(() => {
    if (eager) setVisitedScope(scope);
  }, [eager, scope]);
  // An offscreen visit never unmounts a running chart, drops hidden series,
  // repeats its snapshot request, or changes the active keyboard/legend target.
  return (
    !sharedCanvasChart ||
    eager ||
    visitedScope === scope ||
    typeof IntersectionObserver !== "function"
  );
}
