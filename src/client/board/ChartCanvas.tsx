import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import type { chartOptions } from "./chartOptions";
import { ErrorBox } from "../components/UI";

type ChartOption = ReturnType<typeof chartOptions>;

export default function ChartCanvas({
  option,
  label,
  createOption,
}: {
  option: ChartOption;
  label: string;
  createOption?: (selected: Record<string, boolean>) => ChartOption;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latestOption = useRef(option);
  latestOption.current = option;
  const latestCreateOption = useRef(createOption);
  latestCreateOption.current = createOption;
  const selectedSeries = useRef<Record<string, boolean>>({});
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
      if (!chart || (!force && applied === next && appliedBuilder === builder))
        return;
      attempted = next;
      try {
        if (builder && !listening) {
          chart.on("legendselectchanged", legendChanged);
          listening = true;
        } else if (!builder && listening) {
          chart.off("legendselectchanged", legendChanged);
          listening = false;
          selectedSeries.current = {};
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
          : undefined;
        chart.setOption(
          scrollDataIndex === undefined
            ? resolved
            : {
                ...resolved,
                legend: { ...resolved.legend, scrollDataIndex },
              },
          { notMerge: true },
        );
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

  useEffect(() => {
    session.current?.update(option);
  }, [option, createOption]);

  return (
    <div className="board-chart">
      {/* ECharts owns this element's descendants; React messages stay siblings. */}
      <div
        ref={host}
        style={{ width: "100%", height: "100%" }}
        hidden={failed}
        role={failed ? undefined : "img"}
        aria-label={failed ? undefined : label}
      />
      {failed && (
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
