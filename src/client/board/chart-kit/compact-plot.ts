import { useLayoutEffect, useRef, useState } from "react";
import type { ChartSpec } from "../../../shared/types";
import type { ChartSeriesItem } from "../model";
import { formatChartNumber } from "../chart-number";

/** Board zoom changes screen-space bounds. Geometry uses unscaled CSS pixels. */
export function usePlotViewport() {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { host, ...size };
}

export function metricText(
  item: ChartSeriesItem,
  index: number,
  format: ChartSpec["numberFormat"],
) {
  const value = item.data[index]?.[1];
  return (
    item.displayData?.[index]?.value ??
    (value == null ? "—" : formatChartNumber(value, format))
  );
}

export function categoryText(item: ChartSeriesItem, index: number) {
  const key = String(item.data[index]?.[0] ?? "NULL");
  return item.displayData?.[index]?.x ?? item.categoryLabels?.[key] ?? key;
}
