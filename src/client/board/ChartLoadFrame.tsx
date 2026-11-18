import type { ReactNode } from "react";
import "./chart-loading.css";

export default function ChartLoadFrame({
  busy,
  children,
}: {
  busy: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="chart-load-frame">
      <div className="chart-load-content" aria-busy={busy}>
        {children}
      </div>
      {busy && (
        <div className="chart-load-status" role="status">
          <span className="chart-load-track" aria-hidden="true" />
          <span
            className={
              children ? "chart-load-caption-hidden" : "chart-load-caption"
            }
          >
            {children ? "Обновление графика…" : "Загрузка графика…"}
          </span>
        </div>
      )}
    </div>
  );
}
