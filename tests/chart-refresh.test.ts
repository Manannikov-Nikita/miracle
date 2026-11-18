// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, getResultRows } from "../src/client/api";
import ResultView from "../src/client/board/ResultView";
import type { ChartSpec, ResultPage, ResultSet } from "../src/shared/types";

vi.mock("../src/client/api", () => ({ api: vi.fn(), getResultRows: vi.fn() }));
vi.mock("../src/client/board/BoardChartPlot", () => ({
  default: ({ label }: { label: string }) =>
    createElement("div", { role: "img", "aria-label": label }),
}));

const chart: ChartSpec = { kind: "line", x: "x", y: ["y"], legend: true };
function page(id: string, count: number): ResultPage {
  const rows = Array.from({ length: count }, (_, i) => [String(i), i]);
  const result: ResultSet = {
    id,
    columns: [
      { id: "x", name: "Месяц", type: "String" },
      { id: "y", name: "Продажи", type: "Float64" },
    ],
    rowCount: count,
    byteCount: count * 16,
    createdAt: "2026-11-18",
    source: { connectionId: "connection", sql: "select x,y" },
  };
  return { result, rows, offset: 0, total: count };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  vi.mocked(getResultRows).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function render(id: string, refreshing = false) {
  return act(async () =>
    root.render(
      createElement(ResultView, { id, refreshing, chart, view: "chart" }),
    ),
  );
}
const plot = () => host.querySelector('[role="img"]');
const loading = () => host.querySelector('[aria-busy="true"]');
const status = () => host.querySelector('[role="status"]')?.textContent;

it("keeps the plot through running SQL, new metadata and full rows, and discards superseded reads", async () => {
  const firstRead = Promise.withResolvers<ResultPage>();
  vi.mocked(getResultRows).mockReturnValueOnce(firstRead.promise);
  const first = page("first", 1);
  vi.mocked(api).mockResolvedValueOnce(first);
  await render("first");
  expect(status()).toContain("Загрузка графика");
  expect(loading()).toBeTruthy();
  await act(async () => firstRead.resolve(first));
  const original = plot();
  expect(original?.getAttribute("aria-label")).toContain("1 строк");
  expect(loading()).toBeNull();

  await render("first", true);
  expect(plot()).toBe(original);
  expect(status()).toContain("Обновление графика");
  const secondRead = Promise.withResolvers<ResultPage>();
  const secondRows = Promise.withResolvers<ResultPage>();
  vi.mocked(getResultRows).mockReturnValueOnce(secondRead.promise);
  vi.mocked(api).mockReturnValueOnce(secondRows.promise);
  await render("second");
  expect(plot()).toBe(original);
  expect(loading()).toBeTruthy();
  await act(async () => secondRead.resolve(page("second", 2)));
  expect(plot()).toBe(original);
  expect(loading()).toBeTruthy();

  const latest = page("third", 3);
  vi.mocked(getResultRows).mockResolvedValueOnce(latest);
  vi.mocked(api).mockResolvedValueOnce(latest);
  await render("third");
  expect(loading()).toBeNull();
  expect(plot()?.getAttribute("aria-label")).toContain("3 строк");
  await act(async () => secondRows.resolve(page("second", 2)));
  expect(plot()?.getAttribute("aria-label")).toContain("3 строк");
  expect(status()).toBeUndefined();
});

it("ends loading on failed rows and retries the current snapshot", async () => {
  const first = page("first", 1);
  vi.mocked(getResultRows).mockResolvedValueOnce(first);
  vi.mocked(api).mockResolvedValueOnce(first);
  await render("first");
  const next = page("second", 2);
  vi.mocked(getResultRows).mockResolvedValueOnce(next);
  vi.mocked(api).mockRejectedValueOnce(new Error("snapshot unavailable"));
  await render("second");
  expect(loading()).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "snapshot unavailable",
  );
  const rowsRead = Promise.withResolvers<ResultPage>();
  vi.mocked(api).mockReturnValueOnce(rowsRead.promise);
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(loading()).toBeTruthy();
  await act(async () => rowsRead.resolve(next));
  expect(loading()).toBeNull();
  expect(plot()?.getAttribute("aria-label")).toContain("2 строк");
});

it("keeps the previous chart when a SQL run stops without a new snapshot, and ignores superseded metadata errors", async () => {
  const first = page("first", 1);
  vi.mocked(getResultRows).mockResolvedValueOnce(first);
  vi.mocked(api).mockResolvedValueOnce(first);
  await render("first");
  const original = plot();
  await render("first", true);
  await render("first");
  expect(loading()).toBeNull();
  expect(plot()).toBe(original);

  const obsolete = Promise.withResolvers<ResultPage>();
  vi.mocked(getResultRows).mockReturnValueOnce(obsolete.promise);
  await render("obsolete");
  const current = page("current", 4);
  vi.mocked(getResultRows).mockResolvedValueOnce(current);
  vi.mocked(api).mockResolvedValueOnce(current);
  await render("current");
  await act(async () => obsolete.reject(new Error("old metadata failed")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(status()).toBeUndefined();
  expect(plot()?.getAttribute("aria-label")).toContain("4 строк");
});
