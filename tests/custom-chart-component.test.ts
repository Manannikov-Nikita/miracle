import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import CustomChart from "../src/client/board/CustomChart";

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
async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
afterEach(async () => {
  if (root) await act(() => root.unmount());
  dom?.window.close();
  vi.unstubAllGlobals();
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
  await act(() => resize([{ contentRect: { width: 600, height: 400 } }]));
  await flush(180);
  const first = document.querySelector("iframe")!;
  expect(first).not.toBeNull();
  expect(first.title).toBe("Выручка по месяцам");
  document.querySelector<HTMLElement>(".custom-chart")!.style.transform =
    "scale(.5)";
  await act(() => resize([{ contentRect: { width: 600, height: 400 } }]));
  await flush(150);
  expect(document.querySelector("iframe")).toBe(first);
  await act(() => resize([{ contentRect: { width: 700, height: 400 } }]));
  await flush(180);
  const second = document.querySelector("iframe")!;
  expect(second).not.toBe(first);
  await act(() => {
    document.documentElement.dataset.theme = "light";
  });
  await flush();
  expect(document.querySelector("iframe")).not.toBe(second);
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
  await act(() => resize([{ contentRect: { width: 600, height: 400 } }]));
  await flush(180);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
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
  await flush();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector("iframe")).not.toBeNull();
});
