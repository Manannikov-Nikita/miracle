import { afterEach, expect, it, vi } from "vitest";
import { setTimeout as pause } from "node:timers/promises";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import CustomChart from "../src/client/board/CustomChart";
import type { TableSpec } from "../src/shared/tableTypes";

let dom: JSDOM;
let root: Root;
const spec = {
  version: 1 as const,
  description: "Выручка по месяцам",
  html: "",
  css: "",
  javascript: "",
};
let resize: (entries: any[]) => void;
function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  dom = new JSDOM('<div id="app"></div>', { url: "http://localhost" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: typeof resize) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  root = createRoot(document.getElementById("app")!);
}
async function resizeAndFlush(width: number, height: number) {
  await act(async () => {
    resize([{ contentRect: { width, height } }]);
    // Only the debounce is clock-driven. Native WebCrypto work must settle
    // through the observable DOM checks below, not a guessed wall-clock delay.
    await vi.advanceTimersByTimeAsync(120);
  });
}
async function waitFor(assertion: () => void) {
  const deadline = Date.now() + 3000;
  let lastError: unknown;
  do {
    // End each act scope so React commits effects before the next condition
    // check. The Node timer remains real while browser debounces are faked.
    await act(async () => {
      await pause(10);
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  } while (Date.now() < deadline);
  throw lastError;
}
async function waitForFrame(
  previous?: HTMLIFrameElement,
): Promise<HTMLIFrameElement> {
  let frame: HTMLIFrameElement | null = null;
  await waitFor(() => {
    frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();
    if (previous) expect(frame).not.toBe(previous);
  });
  return frame!;
}
afterEach(async () => {
  if (root) await act(() => root.unmount());
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("sizes from the content box, preserves the frame across zoom and rebuilds on size/theme changes", async () => {
  setup();
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) =>
      Promise.resolve(
        Response.json(
          path.endsWith("/custom-chart")
            ? { columns: [], rows: [] }
            : { ok: true },
        ),
      ),
    ),
  );
  await act(() =>
    root.render(
      React.createElement(CustomChart, {
        boardId: "b",
        nodeId: "n",
        resultSetId: "r",
        spec,
      }),
    ),
  );
  await resizeAndFlush(600, 400);
  const first = await waitForFrame();
  expect(first.title).toBe("Выручка по месяцам");
  document.querySelector<HTMLElement>(".custom-chart")!.style.transform =
    "scale(.5)";
  await resizeAndFlush(600, 400);
  expect(document.querySelector("iframe")).toBe(first);
  await resizeAndFlush(700, 400);
  const second = await waitForFrame(first);
  await act(() => {
    document.documentElement.dataset.theme = "light";
  });
  await waitForFrame(second);
  expect(document.querySelector(".custom-chart-description")?.textContent).toBe(
    "Выручка по месяцам",
  );
});

it("offers a keyboard button to retry a failed fetch and to show the source table", async () => {
  setup();
  let fail = true;
  const table = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) =>
      Promise.resolve(
        Response.json(
          path.endsWith("/custom-chart")
            ? fail
              ? { error: "Снимок недоступен" }
              : { columns: [], rows: [] }
            : { ok: true },
          { status: path.endsWith("/custom-chart") && fail ? 404 : 200 },
        ),
      ),
    ),
  );
  await act(() =>
    root.render(
      React.createElement(CustomChart, {
        boardId: "b",
        nodeId: "n",
        resultSetId: "r",
        spec,
        onShowTable: table,
      }),
    ),
  );
  await resizeAndFlush(600, 400);
  await waitFor(() =>
    expect(document.querySelector('[role="alert"]')).not.toBeNull(),
  );
  const buttons = Array.from(document.querySelectorAll("button"));
  await act(() =>
    buttons
      .find((button) => button.textContent === "Показать таблицу")!
      .click(),
  );
  expect(table).toHaveBeenCalledOnce();
  fail = false;
  await act(() =>
    buttons.find((button) => button.textContent === "Повторить")!.click(),
  );
  await waitForFrame();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("rebuilds custom charts when the table presentation changes and keeps equivalent echoes stable", async () => {
  setup();
  const requests: RequestInit[] = [];
  const reports: { specHash: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: RequestInit) => {
      if (path.endsWith("/custom-chart")) {
        requests.push(init);
        return Promise.resolve(
          Response.json({
            columns: [],
            rows: [],
            displayRows: [],
            cellColors: [],
          }),
        );
      }
      reports.push(JSON.parse(init.body as string));
      return Promise.resolve(Response.json({ ok: true }));
    }),
  );
  const render = async (table?: TableSpec, visibleColumns?: string[]) => {
    await act(() =>
      root.render(
        React.createElement(CustomChart, {
          boardId: "b",
          nodeId: "n",
          resultSetId: "r",
          spec,
          table,
          visibleColumns,
        }),
      ),
    );
  };
  await render();
  await resizeAndFlush(600, 400);
  const first = await waitForFrame();
  const firstHash = reports.at(-1)!.specHash;
  const table: TableSpec = {
    version: 1,
    sourceSchema: "[]",
    columns: { value: { label: "Сумма" } },
  };
  await render(table);
  const second = await waitForFrame(first);
  expect(requests.at(-1)?.method).toBe("POST");
  expect(JSON.parse(requests.at(-1)!.body as string)).toEqual({ table });
  expect(reports.at(-1)!.specHash).not.toBe(firstHash);
  const secondHash = reports.at(-1)!.specHash;
  const count = requests.length;
  await render({
    columns: { value: { label: "Сумма" } },
    sourceSchema: "[]",
    version: 1,
  });
  expect(document.querySelector("iframe")).toBe(second);
  expect(requests).toHaveLength(count);
  await render(table, ["value"]);
  await waitForFrame(second);
  expect(JSON.parse(requests.at(-1)!.body as string)).toEqual({
    table,
    visibleColumns: ["value"],
  });
  expect(reports.at(-1)!.specHash).not.toBe(secondHash);
});
