// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import DateBatchDialog from "../src/client/components/DateBatchDialog";
import DateBatchProgress from "../src/client/components/DateBatchProgress";
import ResultTable from "../src/client/components/ResultTable";
import type {
  DateRangeOptions,
  QueryRun,
  ResultSet,
} from "../src/shared/types";

// jsdom cannot measure scroll containers; keep the table/data flow real.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 30,
        end: (index + 1) * 30,
      })),
    getTotalSize: () => count * 30,
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function setInput(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`,
  )!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(text),
  )!;
}
const initial: DateRangeOptions = {
  startDate: "2026-10-05",
  endDate: "2026-10-19",
  granularity: "day",
  retries: 2,
};

describe("date batch configuration", () => {
  it("previews inclusive date count and submits additional retries once", async () => {
    let resolve!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    await act(async () =>
      root.render(
        createElement(DateBatchDialog, {
          open: true,
          initial,
          onOpenChange() {},
          onSubmit,
        }),
      ),
    );
    expect(document.body.textContent).toContain("15 запросов");
    await setInput("Повторы при ошибке", "3");
    await act(async () => {
      button("Запустить").click();
      button("Запустить").click();
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({ ...initial, retries: 3 });
    await act(async () => resolve());
  });
  it("uses week selection with Monday dates and month selection with first-day dates", async () => {
    const onSubmit = vi.fn(async () => {});
    await act(async () =>
      root.render(
        createElement(DateBatchDialog, {
          open: true,
          initial,
          onOpenChange() {},
          onSubmit,
        }),
      ),
    );
    await act(async () => button("Недели").click());
    expect(
      document
        .querySelector('[aria-label="Начало диапазона"]')
        ?.getAttribute("type"),
    ).toBe("week");
    await setInput("Начало диапазона", "2026-W41");
    await setInput("Конец диапазона", "2026-W43");
    expect(document.body.textContent).toContain("3 запроса");
    await act(async () => button("Запустить").click());
    expect(onSubmit).toHaveBeenLastCalledWith({
      ...initial,
      granularity: "week",
    });
    await act(async () => button("Месяцы").click());
    expect(
      document
        .querySelector('[aria-label="Начало диапазона"]')
        ?.getAttribute("type"),
    ).toBe("month");
    await setInput("Начало диапазона", "2026-01");
    await setInput("Конец диапазона", "2026-03");
    await act(async () => button("Запустить").click());
    expect(onSubmit).toHaveBeenLastCalledWith({
      ...initial,
      startDate: "2026-01-01",
      endDate: "2026-03-01",
      granularity: "month",
    });
  });
  it("prevents reversed ranges and invalid retry counts", async () => {
    const onSubmit = vi.fn(async () => {});
    await act(async () =>
      root.render(
        createElement(DateBatchDialog, {
          open: true,
          initial,
          onOpenChange() {},
          onSubmit,
        }),
      ),
    );
    await setInput("Конец диапазона", "2026-10-01");
    expect(button("Запустить").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await setInput("Конец диапазона", "2026-10-19");
    await setInput("Повторы при ошибке", "11");
    expect(button("Запустить").disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("batch progress and growing result", () => {
  it("exposes completed periods, current retry and failed dates", async () => {
    const run: QueryRun = {
      id: "run",
      source: {
        connectionId: "source",
        sql: "SELECT {{date}}",
        dateRange: initial,
      },
      status: "running",
      startedAt: "2026-10-30",
      batch: {
        total: 3,
        completed: 1,
        succeeded: 0,
        failed: 1,
        currentDate: "2026-10-06",
        attempt: 2,
        items: [
          {
            date: "2026-10-05",
            status: "failed",
            attempts: 3,
            error: "source unavailable",
          },
          { date: "2026-10-06", status: "retrying", attempts: 2 },
          { date: "2026-10-07", status: "pending", attempts: 0 },
        ],
      },
    };
    await act(async () =>
      root.render(createElement(DateBatchProgress, { run })),
    );
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("1");
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuemax"),
    ).toBe("3");
    expect(container.textContent).toContain("2026-10-06");
    expect(container.textContent).toContain("2 из 3");
    expect(container.textContent).toContain("source unavailable");
  });
  it("refreshes same-id result rows on growth without blanking the visible page", async () => {
    let resolve!: (value: Response) => void;
    let reads = 0;
    const result: ResultSet = {
      id: "result",
      rowCount: 1,
      byteCount: 1,
      createdAt: "2026-10-30",
      source: {
        connectionId: "source",
        sql: "SELECT {{date}}",
        dateRange: initial,
      },
      columns: [{ id: "date", name: "date", type: "String" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads++;
        if (reads === 1)
          return new Response(
            JSON.stringify({
              result,
              rows: [["2026-10-05"]],
              offset: 0,
              total: 1,
            }),
          );
        return new Promise<Response>((r) => {
          resolve = r;
        });
      }),
    );
    await act(async () =>
      root.render(createElement(ResultTable, { result, onNotify() {} })),
    );
    expect(container.textContent).toContain("2026-10-05");
    await act(async () =>
      root.render(
        createElement(ResultTable, {
          result: { ...result, rowCount: 2, byteCount: 2 },
          onNotify() {},
        }),
      ),
    );
    expect(reads).toBe(2);
    expect(container.textContent).toContain("2026-10-05");
    await act(async () =>
      resolve(
        new Response(
          JSON.stringify({
            result,
            rows: [["2026-10-05"], ["2026-10-06"]],
            offset: 0,
            total: 2,
          }),
        ),
      ),
    );
    expect(container.textContent).toContain("2026-10-05");
    expect(container.textContent).toContain("2026-10-06");
  });
});

describe("growing result recovery", () => {
  it("does not show or copy the previous page when loading another page fails", async () => {
    const result: ResultSet = {
      id: "paged",
      rowCount: 501,
      byteCount: 1000,
      createdAt: "2026-10-30",
      source: { connectionId: "source", sql: "SELECT 1" },
      columns: [{ id: "date", name: "date", type: "String" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.includes("offset=500")) throw new Error("Page unavailable");
        return new Response(
          JSON.stringify({
            result,
            rows: [["first page row"]],
            offset: 0,
            total: 501,
          }),
        );
      }),
    );
    await act(async () =>
      root.render(createElement(ResultTable, { result, onNotify() {} })),
    );
    expect(container.textContent).toContain("first page row");
    const scroll = container.querySelector<HTMLElement>(
      ".result-table-scroll",
    )!;
    scroll.scrollTo = vi.fn();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Следующая страница"]')!
        .click(),
    );
    expect(container.textContent).toContain("Page unavailable");
    expect(container.textContent).not.toContain("first page row");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Скопировать текущую страницу"]',
      )!.disabled,
    ).toBe(true);
  });
  it("keeps received rows visible after a refresh error and retries the same page", async () => {
    let reads = 0;
    const result: ResultSet = {
      id: "same",
      rowCount: 1,
      byteCount: 1,
      createdAt: "2026-10-30",
      source: {
        connectionId: "source",
        sql: "SELECT {{date}}",
        dateRange: initial,
      },
      columns: [{ id: "date", name: "date", type: "String" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads++;
        if (reads === 2) throw new Error("Disconnected");
        return new Response(
          JSON.stringify({
            result,
            rows: [["kept row"], ...(reads > 2 ? [["new row"]] : [])],
            offset: 0,
            total: reads > 2 ? 2 : 1,
          }),
        );
      }),
    );
    await act(async () =>
      root.render(createElement(ResultTable, { result, onNotify() {} })),
    );
    await act(async () =>
      root.render(
        createElement(ResultTable, {
          result: { ...result, rowCount: 2 },
          onNotify() {},
        }),
      ),
    );
    expect(container.textContent).toContain("kept row");
    expect(container.textContent).toContain("Disconnected");
    await act(async () => button("Повторить").click());
    expect(container.textContent).toContain("kept row");
    expect(container.textContent).toContain("new row");
  });
});
