import type { QueryRun } from "../../shared/types";
import { Spinner } from "./UI";

export default function DateBatchProgress({ run }: { run: QueryRun }) {
  const batch = run.batch;
  if (!batch) return null;
  const running = run.status === "running" || run.status === "cancelling";
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
      {failures.length > 0 && (
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
      {!running && batch.succeeded > 0 && run.status !== "completed" && (
        <p className="date-batch-hint">
          В таблице сохранены результаты успешных дат.
        </p>
      )}
    </div>
  );
}
