import type { QueryRun } from "../shared/types";

function validDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Completed runs never advance with the browser clock, including old history. */
export function queryElapsedMs(run: QueryRun, now: number): number | undefined {
  if (run.status !== "running" && run.status !== "cancelling") {
    if (validDuration(run.elapsedMs)) return run.elapsedMs;
    if (!run.finishedAt) return undefined;
  }
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : undefined;
}

/** Only completed, measured dates contribute; wall time would include pauses. */
export function batchRemainingMs(
  run: QueryRun,
  now: number,
): number | undefined {
  const batch = run.batch;
  if (!batch || run.status !== "running") return undefined;
  const samples = batch.items.filter(
    (item) => item.status === "completed" && validDuration(item.elapsedMs),
  );
  if (!samples.length || batch.completed >= batch.total) return undefined;
  const average =
    samples.reduce((sum, item) => sum + item.elapsedMs!, 0) / samples.length;
  const current = batch.items.find((item) => item.date === batch.currentDate);
  const active = current && ["running", "retrying"].includes(current.status);
  const start = active ? Date.parse(current.activeStartedAt || "") : NaN;
  const currentElapsed = active
    ? (validDuration(current.elapsedMs) ? current.elapsedMs : 0) +
      (Number.isFinite(start) ? Math.max(0, now - start) : 0)
    : 0;
  // A slow current date must not consume the estimate for later pending dates.
  const pending = Math.max(0, batch.total - batch.completed - (active ? 1 : 0));
  return (
    average * pending + (active ? Math.max(0, average - currentElapsed) : 0)
  );
}

export function formatQueryDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} с`;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const tail = String(whole % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes} мин ${tail} с`;
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, "0")} мин ${tail} с`;
}
