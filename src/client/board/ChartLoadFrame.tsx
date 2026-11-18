import type { ReactNode } from "react";
import ChartSkeleton from "./ChartSkeleton";
import "./chart-loading.css";

export default function ChartLoadFrame({
  busy,
  children,
  inlineSkeleton = false,
  refreshing = false,
  horizontal = false,
  color,
}: {
  busy: boolean;
  children?: ReactNode;
  inlineSkeleton?: boolean;
  refreshing?: boolean;
  horizontal?: boolean;
  color?: string;
}) {
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
          {!inlineSkeleton && (
            <ChartSkeleton horizontal={horizontal} color={color} />
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
