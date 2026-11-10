// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DatasetCatalogProvider } from "../src/client/dataset-catalog";
import DatasetTree from "../src/client/components/DatasetTree";
import type { Dataset } from "../src/shared/datasets";
import type { QueryRun } from "../src/shared/types";

const initialDataset: Dataset = {
  id: "sales",
  name: "monthly_sales",
  revision: 2,
  resultSetId: "result-2",
  source: { kind: "local", sql: "select 42 as total" },
  columns: [
    {
      id: "total",
      name: "total",
      type: "INTEGER",
      sourceName: "total",
      duckdbType: "INTEGER",
    },
  ],
  createdAt: "2026-11-10T08:00:00Z",
  updatedAt: "2026-11-10T08:00:00Z",
};
const refreshRun: QueryRun = {
  id: "refresh-sales",
  status: "running",
  source: initialDataset.source,
  startedAt: "2026-11-10T08:01:00Z",
};
let host: HTMLDivElement;
let root: Root;
let dataset: Dataset | undefined;
let activeRun: QueryRun | undefined;
let heldStatus: "running" | "paused" | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  dataset = structuredClone(initialDataset);
  activeRun = undefined;
  heldStatus = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", async (path: string, options?: RequestInit) => {
    if (path === "/api/datasets")
      return Response.json(dataset ? [dataset] : []);
    if (path === "/api/datasets/refreshes")
      return Response.json(
        activeRun &&
          ["running", "cancelling", "paused"].includes(activeRun.status)
          ? [{ datasetId: "sales", run: activeRun }]
          : [],
      );
    if (path === "/api/query-runs/refresh-sales/cancel" && activeRun) {
      activeRun = { ...activeRun, status: "cancelled" };
      return Response.json(activeRun);
    }
    if (path === "/api/query-runs/refresh-sales/resume" && activeRun) {
      heldStatus = undefined;
      activeRun = { ...activeRun, status: "running" };
      return Response.json(activeRun);
    }
    if (path === "/api/query-runs/refresh-sales") {
      if (heldStatus || activeRun?.status === "cancelled")
        return Response.json(activeRun);
      dataset = {
        ...dataset!,
        revision: dataset!.revision + 1,
        resultSetId: "refreshed-result",
      };
      activeRun = {
        ...refreshRun,
        status: "completed",
        resultSetId: "refreshed-result",
      };
      return Response.json(activeRun);
    }
    const body = JSON.parse(String(options?.body ?? "{}"));
    if (!dataset || body.baseRevision !== dataset.revision)
      return Response.json({ error: "Revision conflict" }, { status: 409 });
    if (path === "/api/datasets/sales" && options?.method === "PATCH") {
      dataset = { ...dataset, name: body.name, revision: 3 };
      return Response.json(dataset);
    }
    if (path === "/api/datasets/sales/refresh" && options?.method === "POST") {
      activeRun = { ...refreshRun, status: heldStatus ?? "running" };
      if (heldStatus === "paused") {
        activeRun.batch = {
          total: 1,
          completed: 0,
          succeeded: 0,
          failed: 0,
          currentDate: "2026-11-10",
          attempt: 1,
          items: [{ date: "2026-11-10", status: "failed", attempts: 1 }],
        };
      }
      return Response.json(activeRun);
    }
    if (path === "/api/datasets/sales" && options?.method === "DELETE") {
      dataset = undefined;
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unexpected request" }, { status: 400 });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const onOpenSource = vi.fn();
  const onNotify = vi.fn();
  await act(async () =>
    root.render(
      createElement(DatasetCatalogProvider, {
        onNotify,
        children: createElement(DatasetTree, { filter: "", onOpenSource }),
      }),
    ),
  );
  return { onOpenSource, onNotify };
}

async function menuAction(name: string, action: string) {
  const trigger = host.querySelector<HTMLButtonElement>(
    `[aria-label="Действия датасета ${name}"]`,
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((element) => element.textContent?.trim() === action);
  expect(item).toBeDefined();
  await act(async () => item!.click());
}

it("shows SQL column types and opens a query for a named dataset", async () => {
  const { onOpenSource } = await mount();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        'button[aria-expanded="false"][title="monthly_sales"]',
      )!
      .click(),
  );
  expect(host.textContent).toContain("total");
  expect(host.textContent).toContain("INTEGER");
  await menuAction("monthly_sales", "Написать запрос");
  expect(onOpenSource).toHaveBeenCalledWith(
    { kind: "local", sql: 'SELECT *\nFROM "monthly_sales"\nLIMIT 100;' },
    "monthly_sales.sql",
  );
  await menuAction("monthly_sales", "Редактировать исходный SQL");
  expect(onOpenSource).toHaveBeenLastCalledWith(
    { kind: "local", sql: "select 42 as total" },
    "monthly_sales_source.sql",
    { id: "sales", revision: 2 },
  );
});

it("uses the current dataset revision when renaming, refreshing, and deleting from the explorer", async () => {
  const { onNotify } = await mount();
  await menuAction("monthly_sales", "Переименовать");
  const dialog = document.querySelector('[role="dialog"]')!;
  const input = dialog.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "regional_sales");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );
  expect(host.textContent).toContain("regional_sales");
  await menuAction("regional_sales", "Обновить датасет");
  expect(onNotify).toHaveBeenCalledWith("Датасет обновлён.", "success");
  await menuAction("regional_sales", "Удалить");
  const confirm = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((button) => button.textContent === "Удалить")!;
  await act(async () => confirm.click());
  expect(host.textContent).not.toContain("regional_sales");
});

it.each([
  ["running", "Обновление датасета…", "Остановить", "cancelled"],
  ["paused", "Серия приостановлена", "Продолжить", "completed"],
] as const)(
  "restores a %s dataset refresh after remount",
  async (status, progress, action, terminal) => {
    heldStatus = status;
    await mount();
    await menuAction("monthly_sales", "Обновить датасет");
    expect(host.textContent).toContain(progress);

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(host.textContent).toContain(progress);
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === action,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(activeRun?.status).toBe(terminal);
    expect(host.textContent).not.toContain(progress);
  },
);
