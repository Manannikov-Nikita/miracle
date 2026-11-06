import { useEffect, useState } from "react";
import type { QueryRun } from "../../shared/types";
import {
  batchRemainingMs,
  formatQueryDuration,
  queryElapsedMs,
} from "../query-timing";
import "./query-timing.css";

function useRunClock(run: QueryRun, ticking: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [run.id, ticking]);
  return Date.now();
}

export function QueryDuration({ run }: { run: QueryRun }) {
  const now = useRunClock(run, ["running", "cancelling"].includes(run.status));
  const duration = queryElapsedMs(run, now);
  if (duration === undefined) return null;
  return (
    <span className="query-duration" aria-label="Время выполнения">
      {formatQueryDuration(duration)}
    </span>
  );
}

export function BatchRemainingTime({ run }: { run: QueryRun }) {
  const now = useRunClock(run, run.status === "running");
  if (run.status !== "running" || !run.batch) return null;
  const remaining = batchRemainingMs(run, now);
  if (run.batch.completed >= run.batch.total) return null;
  return (
    <div className="batch-time-estimate">
      {remaining === undefined ? (
        <span>Оценка появится после завершения даты</span>
      ) : remaining === 0 ? (
        <span>Завершение текущей даты…</span>
      ) : (
        <span aria-label="Оставшееся время">
          Осталось примерно {formatQueryDuration(remaining)}
        </span>
      )}
    </div>
  );
}
