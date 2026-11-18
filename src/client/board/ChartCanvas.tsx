import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import type { chartOptions } from "./chartOptions";
import { ErrorBox } from "../components/UI";
import ChartSkeleton, { type ChartSkeletonProps } from "./ChartSkeleton";
import type { ChartSpec } from "../../shared/types";

type ChartOption = ReturnType<typeof chartOptions>;

function stackBaseline(option: ChartOption, selected: Record<string, boolean>) {
  let min = 0;
  let max = 0;
  for (const item of option.series) {
    if (item.type !== "bar" || !item.stack || selected[item.name] === false)
      continue;
    for (const point of item.data) {
      const value = (Array.isArray(point) ? point : point.value)[1] ?? 0;
      min = Math.min(min, value);
      max = Math.max(max, value);
      if (min < 0 && max > 0) return 0.5;
    }
  }
  if (min < 0) return option.yAxis.type === "category" ? 1 : 0;
  return undefined;
}

function nativeLoadingPreview(
  option: ChartOption,
  selected: Record<string, boolean>,
  spec?: ChartSpec,
): ChartSkeletonProps {
  const first = option.series[0];
  const series = option.series.flatMap((item, index) =>
    selected[item.name] === false
      ? []
      : [
          {
            metricId: item.stack?.slice("metric:".length) ?? item.name,
            color: item.itemStyle.color,
            index,
          },
        ],
  );
  return {
    spec: spec ?? {
      kind: first?.areaStyle ? "area" : (first?.type ?? "bar"),
      x: option.xAxis.name ?? "",
      y: [...new Set(series.map((s) => s.metricId))],
      stacked: Boolean(first?.stack),
      series: first?.stack,
      legend: option.legend.show,
      orientation: option.yAxis.type === "category" ? "horizontal" : "vertical",
      showGrid: option.xAxis.splitLine.show || option.yAxis.splitLine.show,
    },
    series: series.length ? series : undefined,
    baseline: stackBaseline(option, selected),
    count:
      option.xAxis.data?.length ??
      option.yAxis.data?.length ??
      first?.data.length,
  };
}

export default function ChartCanvas({
  option,
  spec,
  label,
  createOption,
  loading = false,
}: {
  option: ChartOption;
  spec?: ChartSpec;
  label: string;
  loading?: boolean;
  createOption?: (selected: Record<string, boolean>) => ChartOption;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latestLoading = useRef(loading);
  latestLoading.current = loading;
  const latestOption = useRef(option);
  latestOption.current = option;
  const latestCreateOption = useRef(createOption);
  latestCreateOption.current = createOption;
  const selectedSeries = useRef<Record<string, boolean>>({});
  const [loadingSelection, setLoadingSelection] = useState<
    Record<string, boolean>
  >({});
  const session = useRef<{ update: (next: ChartOption) => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = error !== null;
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let chart: ReturnType<typeof echarts.init> | undefined;
    let observer: ResizeObserver | undefined;
    let stopped = false;
    let disposed = false;
    let applied: ChartOption | undefined;
    let appliedBuilder: typeof createOption;
    let listening = false;
    let attempted = latestOption.current;
    let reveal = true;
    let deferredResize = false;
    let pageAfterLoading: number | undefined;
    const dispose = () => {
      observer?.disconnect();
      observer = undefined;
      if (disposed) return;
      disposed = true;
      try {
        if (chart && listening) {
          chart.off("legendselectchanged", legendChanged);
          listening = false;
        }
        // init can register an instance before throwing. It still needs cleanup.
        (chart ?? echarts.getInstanceByDom(element))?.dispose();
      } catch (error) {
        console.error("Не удалось освободить график ECharts:", error);
      }
    };
    const fail = (stage: string, error: unknown) => {
      if (stopped) return;
      stopped = true;
      console.error(`Не удалось отобразить график ECharts (${stage}):`, error);
      dispose();
      setError(
        error instanceof Error ? error.message || error.name : String(error),
      );
    };
    function legendChanged(event: unknown) {
      if (
        stopped ||
        !latestCreateOption.current ||
        !event ||
        typeof event !== "object"
      )
        return;
      const selected = (event as { selected?: Record<string, boolean> })
        .selected;
      if (!selected) return;
      selectedSeries.current = { ...selected };
      update(latestOption.current, true);
    }
    const update = (next: ChartOption, force = false) => {
      if (stopped) {
        // A new setting can recover a failed renderer without fetching rows again.
        if (next !== attempted) {
          attempted = next;
          setError(null);
          setRetry((value) => value + 1);
        }
        return;
      }
      const builder = latestCreateOption.current;
      if (!chart) return;
      attempted = next;
      try {
        if (latestLoading.current) {
          if (!reveal && applied) {
            const legend = chart.getOption().legend;
            const state = Array.isArray(legend)
              ? (legend[0] as {
                  selected?: Record<string, boolean>;
                  scrollDataIndex?: number;
                })
              : undefined;
            selectedSeries.current = {
              ...selectedSeries.current,
              ...state?.selected,
            };
            setLoadingSelection(selectedSeries.current);
            pageAfterLoading = state?.scrollDataIndex;
            // Remove old series views and their running transitions. The chart
            // instance, its canvas size and its legend event subscription survive.
            chart.clear();
          }
          reveal = true;
          return;
        }
        if (!reveal && !force && applied === next && appliedBuilder === builder)
          return;
        if (builder && !listening) {
          chart.on("legendselectchanged", legendChanged);
          listening = true;
        } else if (!builder && listening) {
          chart.off("legendselectchanged", legendChanged);
          listening = false;
          if (!reveal) selectedSeries.current = {};
        }
        const names = new Set(next.series.map((series) => series.name));
        selectedSeries.current = Object.fromEntries(
          Object.entries(selectedSeries.current).filter(([name]) =>
            names.has(name),
          ),
        );
        const resolved = builder ? builder(selectedSeries.current) : next;
        // Recalculating totals must not jump away from the legend page clicked.
        const legend = force ? chart.getOption().legend : undefined;
        const scrollDataIndex = Array.isArray(legend)
          ? (legend[0] as { scrollDataIndex?: number } | undefined)
              ?.scrollDataIndex
          : pageAfterLoading;
        const animate =
          reveal &&
          !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (deferredResize) chart.resize();
        chart.setOption(
          {
            ...resolved,
            legend: {
              ...resolved.legend,
              ...(reveal
                ? {
                    selected: {
                      ...resolved.legend.selected,
                      ...selectedSeries.current,
                    },
                  }
                : {}),
              ...(scrollDataIndex !== undefined ? { scrollDataIndex } : {}),
            },
            ...(animate
              ? {
                  series: resolved.series.map((item) => ({
                    ...item,
                    animation: true,
                    animationThreshold: 5000,
                    animationDuration: item.type === "bar" ? 1100 : 350,
                    animationEasing: "cubicInOut",
                    animationDurationUpdate: 0,
                    animationDelay:
                      item.type === "bar"
                        ? (index: number) =>
                            (index * 440) / Math.max(1, item.data.length)
                        : 0,
                  })),
                }
              : {}),
          },
          { notMerge: true },
        );
        reveal = false;
        deferredResize = false;
        pageAfterLoading = undefined;
        applied = next;
        appliedBuilder = builder;
      } catch (error) {
        fail("setOption", error);
      }
    };
    session.current = { update };
    try {
      chart = echarts.init(element, "dark");
      update(latestOption.current);
      if (!stopped) {
        observer = new ResizeObserver(() => {
          if (stopped) return;
          if (latestLoading.current) {
            deferredResize = true;
            return;
          }
          try {
            chart?.resize();
          } catch (error) {
            fail("resize", error);
          }
        });
        observer.observe(element);
      }
    } catch (error) {
      fail("init", error);
    }
    return () => {
      stopped = true;
      session.current = null;
      dispose();
    };
  }, [retry]);

  // Install the resolved data before the now-visible canvas can paint a stale frame.
  useLayoutEffect(() => {
    session.current?.update(option);
  }, [option, createOption, loading]);

  return (
    <div className="board-chart" style={{ position: "relative" }}>
      {/* ECharts owns this element's descendants; React messages stay siblings. */}
      <div
        ref={host}
        style={{
          width: "100%",
          height: "100%",
          visibility: loading ? "hidden" : undefined,
        }}
        hidden={failed}
        role={failed || loading ? undefined : "img"}
        aria-label={failed || loading ? undefined : label}
      />
      {loading && (
        <ChartSkeleton
          {...nativeLoadingPreview(option, loadingSelection, spec)}
        />
      )}
      {failed && !loading && (
        <ErrorBox
          className="board-error nowheel"
          error={error}
          title="Не удалось отобразить график."
          hint="Повторите отображение. Если ошибка повторится, измените настройки графика в свойствах блока."
          actions={
            <button
              type="button"
              onClick={() => {
                setError(null);
                setRetry((value) => value + 1);
              }}
            >
              Повторить
            </button>
          }
        />
      )}
    </div>
  );
}
