import { useContext, type ReactNode } from "react";
import { BoardChartOverviewContext } from "./board-chart-overview";
import ChartSkeleton, { type ChartSkeletonProps } from "./ChartSkeleton";
import "./chart-loading.css";

export default function ChartLoadFrame({
  busy,
  children,
  inlineSkeleton = false,
  refreshing = false,
  spec,
  count,
}: {
  busy: boolean;
  children?: ReactNode;
  inlineSkeleton?: boolean;
  refreshing?: boolean;
} & Pick<ChartSkeletonProps, "spec" | "count">) {
  const overview = useContext(BoardChartOverviewContext);
  return (
    <div
      className="chart-load-frame"
      data-thumbnail-loading={(overview && busy) || undefined}
    >
      <div
        className="chart-load-content"
        aria-busy={busy}
        aria-hidden={busy || undefined}
        inert={busy}
      >
        {children}
      </div>
      {busy && (
        <>
          {!overview && !inlineSkeleton && (
            <ChartSkeleton spec={spec} count={count} />
          )}
          <span className="chart-load-announcement" role="status">
            {refreshing || children
              ? "Обновление графика…"
              : "Загрузка графика…"}
          </span>
        </>
      )}
    </div>
  );
}
