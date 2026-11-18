import type { ReactNode } from "react";
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
  return (
    <div className="chart-load-frame">
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
          {!inlineSkeleton && <ChartSkeleton spec={spec} count={count} />}
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
