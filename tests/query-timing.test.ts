// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import DateBatchProgress from "../src/client/components/DateBatchProgress";
import type { QueryRun } from "../src/shared/types";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function batchRun(): QueryRun {
  return {
    id: "batch",
    source: { connectionId: "c", sql: "SELECT {{date}}" },
    status: "running",
    // A long pause before the current active segment must not enter the average.
    startedAt: "2026-11-04T10:00:00Z",
    batch: {
      total: 4,
      completed: 2,
      succeeded: 2,
      failed: 0,
      attempt: 1,
      currentDate: "2026-11-03",
      items: [
        {
          date: "2026-11-01",
          status: "completed",
          attempts: 1,
          elapsedMs: 10000,
        },
        {
          date: "2026-11-02",
          status: "completed",
          attempts: 1,
          elapsedMs: 30000,
        },
        {
          date: "2026-11-03",
          status: "running",
          attempts: 1,
          elapsedMs: 2000,
          activeStartedAt: "2026-11-05T09:59:57Z",
        },
        { date: "2026-11-04", status: "pending", attempts: 0 },
      ],
    },
  };
}
async function render(run: QueryRun) {
  await act(async () => root.render(createElement(DateBatchProgress, { run })));
}
it("estimates remaining dates from completed samples and current active time", async () => {
  await render(batchRun());
  // (10s + 30s) / 2 = 20s per date; 2 remain, with 5s already spent.
  expect(
    container.querySelector('[aria-label="Оставшееся время"]')?.textContent,
  ).toBe("Осталось примерно 35.0 с");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(
    container.querySelector('[aria-label="Оставшееся время"]')?.textContent,
  ).toBe("Осталось примерно 34.0 с");
});
it("does not invent a sample for old runs or before the first completed date", async () => {
  const run = batchRun();
  for (const item of run.batch!.items) delete item.elapsedMs;
  await render(run);
  expect(container.textContent).toContain(
    "Оценка появится после завершения даты",
  );
  expect(container.querySelector('[aria-label="Оставшееся время"]')).toBeNull();
});
it.each([
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "interrupted",
] as const)(
  "removes the live estimate when the run becomes %s",
  async (status) => {
    const run = batchRun();
    await render(run);
    await render({ ...run, status });
    const text = container.textContent;
    expect(
      container.querySelector('[aria-label="Оставшееся время"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Оценка появится");
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(container.textContent).toBe(text);
  },
);
it("does not predict zero while an over-average date is still running", async () => {
  const run = batchRun();
  run.batch!.total = 3;
  run.batch!.items.pop();
  run.batch!.items[2]!.activeStartedAt = "2026-11-05T09:00:00Z";
  await render(run);
  expect(container.textContent).toContain("Завершение текущей даты…");
  expect(container.textContent).not.toContain("Осталось примерно 0");
});
