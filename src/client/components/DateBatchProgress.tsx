import type { QueryRun } from "../../shared/types";
import { Spinner } from "./UI";

export default function DateBatchProgress({
  run,
  onResume,
  onCancel,
  action,
  actionError,
}: {
  run: QueryRun;
  onResume?: () => void;
  onCancel?: () => void;
  action?: "resume" | "cancel";
  actionError?: string;
}) {
  const batch = run.batch;
  if (!batch) return null;
  const running = run.status === "running" || run.status === "cancelling";
  const paused = run.status === "paused";
  const current = batch.items.find((item) => item.date === batch.currentDate);
  const failures = batch.items.filter(
    (item) => item.status === "failed" || item.status === "interrupted",
  );
  const percent = batch.total
    ? Math.min(100, (batch.completed / batch.total) * 100)
    : 0;
  return (
    <div className="date-batch-progress">
      <div className="batch-progress-heading" aria-live="polite">
        <span>
          {running && <Spinner />}
          {run.status === "cancelling"
            ? "Останавливаем серию…"
            : running
              ? "Запуск по датам"
              : paused
                ? "Серия приостановлена"
                : run.status === "cancelled"
                  ? "Серия остановлена"
                  : run.status === "interrupted"
                    ? "Серия прервана"
                    : batch.failed
                      ? "Серия завершена с ошибками"
                      : "Серия завершена"}
        </span>
        <strong>
          {batch.completed} / {batch.total}
        </strong>
      </div>
      <div
        className="batch-progress-track"
        role="progressbar"
        aria-label="Прогресс запуска по датам"
        aria-valuemin={0}
        aria-valuemax={batch.total}
        aria-valuenow={batch.completed}
        aria-valuetext={`${batch.completed} из ${batch.total}; успешно ${batch.succeeded}; ошибок ${batch.failed}`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {!paused && (
        <div className="batch-progress-details">
          <span>
            Успешно: {batch.succeeded}
            {batch.failed ? ` · Ошибок: ${batch.failed}` : ""}
          </span>
          {running && batch.currentDate && (
            <span>
              {batch.currentDate} ·{" "}
              {current?.status === "retrying" ? "Повтор" : "Попытка"}{" "}
              {batch.attempt} из {(run.source.dateRange?.retries ?? 0) + 1}
            </span>
          )}
        </div>
      )}
      {paused && (
        <div className="batch-pause">
          <div className="batch-pause-message" role="status">
            <strong>Ошибка · {batch.currentDate}</strong>
            {(current?.error || run.error) && (
              <details className="batch-pause-diagnostic">
                <summary>Подробнее</summary>
                <p className="batch-pause-error">
                  {current?.error || run.error}
                </p>
              </details>
            )}
          </div>
          <div className="batch-pause-actions">
            {onResume && (
              <button
                className="button primary"
                disabled={!!action}
                onClick={onResume}
              >
                {action === "resume" ? (
                  <>
                    <Spinner /> Продолжаем…
                  </>
                ) : (
                  "Продолжить"
                )}
              </button>
            )}
            {onCancel && (
              <button className="button" disabled={!!action} onClick={onCancel}>
                {action === "cancel" ? "Останавливаем…" : "Остановить"}
              </button>
            )}
          </div>
          {actionError && (
            <p className="batch-pause-error" role="alert">
              {actionError}
            </p>
          )}
        </div>
      )}
      {!paused && failures.length > 0 && (
        <details className="batch-failures">
          <summary>Ошибки по датам · {failures.length}</summary>
          <ul>
            {failures.map((item) => (
              <li key={item.date}>
                <strong>{item.date}</strong>
                <span>{item.error || "Запрос не завершён"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!running &&
        !paused &&
        batch.succeeded > 0 &&
        run.status !== "completed" && (
          <p className="date-batch-hint">
            В таблице сохранены результаты успешных дат.
          </p>
        )}
    </div>
  );
}
