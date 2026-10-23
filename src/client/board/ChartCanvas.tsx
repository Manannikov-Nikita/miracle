import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import type { chartOptions } from "./chartOptions";

type ChartOption = ReturnType<typeof chartOptions>;

export default function ChartCanvas({
  option,
  label,
}: {
  option: ChartOption;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latestOption = useRef(option);
  latestOption.current = option;
  const session = useRef<{ update: (next: ChartOption) => void } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let chart: ReturnType<typeof echarts.init> | undefined;
    let observer: ResizeObserver | undefined;
    let stopped = false;
    let disposed = false;
    let applied: ChartOption | undefined;
    let attempted = latestOption.current;
    const dispose = () => {
      observer?.disconnect();
      observer = undefined;
      if (disposed) return;
      disposed = true;
      try {
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
      setFailed(true);
    };
    const update = (next: ChartOption) => {
      if (stopped) {
        // A new setting can recover a failed renderer without fetching rows again.
        if (next !== attempted) {
          attempted = next;
          setFailed(false);
          setRetry((value) => value + 1);
        }
        return;
      }
      if (!chart || applied === next) return;
      attempted = next;
      try {
        chart.setOption(next, { notMerge: true });
        applied = next;
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
  }, [option]);

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
        <div className="board-error" role="alert">
          Не удалось отобразить график.
          <button
            onClick={() => {
              setFailed(false);
              setRetry((value) => value + 1);
            }}
          >
            Повторить
          </button>
        </div>
      )}
    </div>
  );
}
