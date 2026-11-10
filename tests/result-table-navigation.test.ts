// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ResultTable from "../src/client/components/ResultTable";
import { api, getResultRows } from "../src/client/api";
import type { ResultSet } from "../src/shared/types";

vi.mock("../src/client/api", () => ({
  api: vi.fn(),
  getResultRows: vi.fn(async () => ({ rows: [[1]] })),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(getResultRows).mockClear();
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
});
async function render(rowCount: number, id = "result") {
  await act(async () =>
    root.render(
      createElement(ResultTable, {
        result: {
          id,
          rowCount,
          byteCount: rowCount * 10,
          columns: [{ id: "n", name: "n", type: "Int64" }],
        } as ResultSet,
        onNotify() {},
      }),
    ),
  );
}
function button(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}
it("omits pagination for a single page while retaining copy", async () => {
  await render(1);
  expect(button("Предыдущая страница")).toBeNull();
  expect(button("Следующая страница")).toBeNull();
  expect(button("Скопировать текущую страницу")).not.toBeNull();
});
it("copies all stored SQL rows to Markdown including rows beyond the current page", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => [index]);
  vi.mocked(api).mockResolvedValue({ rows });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  await render(501);
  const copy = button("Скопировать таблицу в Markdown");
  expect(copy).not.toBeNull();
  await act(async () => copy!.click());
  expect(writeText).toHaveBeenCalledOnce();
  const text = writeText.mock.calls[0][0] as string;
  expect(text.startsWith("| n |\n| --- |\n| 0 |")).toBe(true);
  expect(text.endsWith("| 500 |")).toBe(true);
  expect(text.split("\n")).toHaveLength(503);
});
it("copies newly completed date-batch rows when the same result ID grows", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ rows: [[1]] })
    .mockResolvedValueOnce({ rows: [[1], [2], [3]] });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  await render(1, "growing-date-batch");
  await act(async () => button("Скопировать таблицу в Markdown")!.click());
  expect(writeText).toHaveBeenLastCalledWith("| n |\n| --- |\n| 1 |");

  await render(3, "growing-date-batch");
  await act(async () => button("Скопировать таблицу в Markdown")!.click());
  expect(writeText).toHaveBeenLastCalledWith(
    "| n |\n| --- |\n| 1 |\n| 2 |\n| 3 |",
  );
});
it("navigates multi-page results and recovers when the snapshot shrinks", async () => {
  await render(501);
  expect(button("Предыдущая страница")?.disabled).toBe(true);
  await act(async () => button("Следующая страница")!.click());
  expect(getResultRows).toHaveBeenLastCalledWith("result", 500, 500);
  expect(button("Предыдущая страница")?.disabled).toBe(false);
  await render(1);
  expect(getResultRows).toHaveBeenLastCalledWith("result", 0, 500);
  expect(button("Следующая страница")).toBeNull();
  expect(host.textContent).not.toContain("501–1");
});
it("keeps full loading diagnostics behind a click and retries only the result page", async () => {
  const details =
    "Result snapshot could not be read\n" + "diagnostic line\n".repeat(200);
  vi.mocked(getResultRows).mockRejectedValueOnce(
    Object.assign(new Error("Snapshot failed"), { details }),
  );
  await render(1);
  const disclosure = host.querySelector("details")!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector("pre")!.textContent).toContain(details);
  await act(async () => disclosure.querySelector("summary")!.click());
  expect(getResultRows).toHaveBeenCalledOnce();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === "Повторить загрузку")!
      .click(),
  );
  expect(getResultRows).toHaveBeenLastCalledWith("result", 0, 500);
  expect(host.querySelector("details")).toBeNull();
});
