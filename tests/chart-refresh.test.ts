// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, getResultRows } from "../src/client/api";
import ResultView from "../src/client/board/ResultView";
import type { ChartSpec, ResultPage, ResultSet } from "../src/shared/types";

vi.mock("../src/client/api", () => ({ api: vi.fn(), getResultRows: vi.fn() }));
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
function render(id: string, refreshing = false, spec = chart) {
  return act(async () =>
    root.render(
      createElement(ResultView, { id, refreshing, chart: spec, view: "chart" }),
    ),
  );
}
const plot = () => host.querySelector('.bk-cartesian svg[role="img"]');
const loading = () => host.querySelector('[aria-busy="true"]');
const status = () => host.querySelector('[role="status"]')?.textContent;

function expectSkeleton() {
  expect(loading()).toBeTruthy();
  expect(host.querySelectorAll(".chart-skeleton")).toHaveLength(1);
  const announcements = [...host.querySelectorAll('[role="status"]')].filter(
    (el) => !el.closest('[aria-hidden="true"], [inert]'),
  );
  expect(announcements).toHaveLength(1);
  for (const retained of host.querySelectorAll(
    '.bk-cartesian svg[role="img"], .bk-legend button, [role="tooltip"]',
  )) {
    expect(retained.closest("[inert]")).not.toBeNull();
    expect(retained.closest('[aria-hidden="true"]')).not.toBeNull();
  }
}

function expectReady() {
  expect(loading()).toBeNull();
  expect(host.querySelector(".chart-skeleton")).toBeNull();
  const visible = plot();
  expect(visible).not.toBeNull();
  expect(visible!.closest('[aria-hidden="true"], [inert]')).toBeNull();
}

it("shows loading feedback through running SQL, new metadata and full rows, and discards superseded reads", async () => {
  const firstRead = Promise.withResolvers<ResultPage>();
  vi.mocked(getResultRows).mockReturnValueOnce(firstRead.promise);
  const first = page("first", 1);
  vi.mocked(api).mockResolvedValueOnce(first);
  await render("first");
  expect(status()).toContain("Загрузка графика");
  expectSkeleton();
  await act(async () => firstRead.resolve(first));
  const original = plot();
  expect(original?.getAttribute("aria-label")).toContain("1 строк");
  expectReady();

  await render("first", true);
  expectSkeleton();
  expect(status()).toContain("Обновление графика");
  const secondRead = Promise.withResolvers<ResultPage>();
  const secondRows = Promise.withResolvers<ResultPage>();
  vi.mocked(getResultRows).mockReturnValueOnce(secondRead.promise);
  vi.mocked(api).mockReturnValueOnce(secondRows.promise);
  await render("second");
  expectSkeleton();
  await act(async () => secondRead.resolve(page("second", 2)));
  expectSkeleton();

  const latest = page("third", 3);
  vi.mocked(getResultRows).mockResolvedValueOnce(latest);
  vi.mocked(api).mockResolvedValueOnce(latest);
  await render("third");
  expectReady();
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
  expect(host.querySelector(".chart-skeleton")).toBeNull();
  expect(plot()).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "snapshot unavailable",
  );
  const rowsRead = Promise.withResolvers<ResultPage>();
  vi.mocked(api).mockReturnValueOnce(rowsRead.promise);
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expectSkeleton();
  await act(async () => rowsRead.resolve(next));
  expectReady();
  expect(plot()?.getAttribute("aria-label")).toContain("2 строк");
});

it("keeps the previous chart when a SQL run stops without a new snapshot, and ignores superseded metadata errors", async () => {
  const first = page("first", 1);
  first.result.columns.push({ id: "plan", name: "План", type: "Float64" });
  first.rows = first.rows.map((row) => [...row, 100]);
  const twoSeries = { ...chart, y: ["y", "plan"] };
  vi.mocked(getResultRows).mockResolvedValueOnce(first);
  vi.mocked(api).mockResolvedValueOnce(first);
  await render("first", false, twoSeries);
  const original = plot();
  const plan = () =>
    host.querySelector<HTMLButtonElement>('.bk-legend button[title="План"]');
  await act(async () => plan()!.click());
  expect(plan()!.getAttribute("aria-pressed")).toBe("false");
  await render("first", true, twoSeries);
  expectSkeleton();
  await render("first", false, twoSeries);
  expectReady();
  expect(plot()).toBe(original);
  expect(plan()!.getAttribute("aria-pressed")).toBe("false");

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

it.each(["metadata", "rows"] as const)(
  "shows refresh feedback after a previous %s error and restores the retry action on cancellation",
  async (stage) => {
    const first = page("first", 1);
    const failure = new Error("saved snapshot unavailable");
    if (stage === "metadata")
      vi.mocked(getResultRows).mockRejectedValueOnce(failure);
    else {
      vi.mocked(getResultRows).mockResolvedValueOnce(first);
      vi.mocked(api).mockRejectedValueOnce(failure);
    }
    await render("first");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      failure.message,
    );
    expect(host.querySelector(".chart-skeleton")).toBeNull();

    await render("first", true);
    expectSkeleton();
    const staleRetry = host.querySelector('[role="alert"] button');
    if (staleRetry) expect(staleRetry.closest("[inert]")).not.toBeNull();
    await render("first");
    expect(loading()).toBeNull();
    expect(host.querySelector(".chart-skeleton")).toBeNull();
    const retry = host.querySelector<HTMLButtonElement>(
      '[role="alert"] button',
    );
    expect(retry).not.toBeNull();
    expect(retry!.closest('[inert], [aria-hidden="true"]')).toBeNull();
    vi.mocked(getResultRows).mockResolvedValueOnce(first);
    vi.mocked(api).mockResolvedValueOnce(first);
    await act(async () => retry!.click());
    expectReady();
  },
);

it("clears the retained chart and loading indicator when replacement rows are empty", async () => {
  const first = page("first", 1);
  vi.mocked(getResultRows).mockResolvedValueOnce(first);
  vi.mocked(api).mockResolvedValueOnce(first);
  await render("first");
  expectReady();
  const empty = page("empty", 0);
  const readRows = Promise.withResolvers<ResultPage>();
  vi.mocked(getResultRows).mockResolvedValueOnce(empty);
  vi.mocked(api).mockReturnValueOnce(readRows.promise);
  await render("empty");
  expectSkeleton();
  await act(async () => readRows.resolve(empty));
  expect(loading()).toBeNull();
  expect(host.querySelector(".chart-skeleton")).toBeNull();
  expect(plot()).toBeNull();
  expect(host.textContent).toContain("В результате нет строк.");
});
