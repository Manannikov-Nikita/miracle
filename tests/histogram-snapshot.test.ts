// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { useChartTableData } from "../src/client/board/useChartTableData";
import type { ResultSet, Cell } from "../src/shared/types";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
type Mode = NonNullable<Parameters<typeof useChartTableData>[3]>;
type Response = { rows: Cell[][]; result: ResultSet };
const result: ResultSet = {
  id: "",
  columns: [{ id: "n", type: "Float64", name: "Сумма" }],
  rowCount: 6000,
  byteCount: 40000,
  createdAt: "2026-11-18",
  source: { connectionId: "connection", sql: "select n" },
};
function Preview({ result, mode }: { result: ResultSet; mode: Mode }) {
  const { data, error } = useChartTableData(result, undefined, undefined, mode);
  return createElement(
    "output",
    {},
    String(error?.message ?? data?.rows.length ?? "pending"),
  );
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("shares the complete table snapshot between the histogram and inspector and ignores an older /chart response", async () => {
  const snapshot = { ...result, id: "histogram-shared" };
  const chartRead = Promise.withResolvers<Response>(),
    tableRead = Promise.withResolvers<Response>();
  vi.mocked(api)
    .mockReturnValueOnce(chartRead.promise)
    .mockReturnValueOnce(tableRead.promise);
  const render = async (mode: Mode, inspector = false) =>
    act(async () =>
      root.render(
        createElement(Fragment, {}, [
          createElement(Preview, { key: "plot", result: snapshot, mode }),
          inspector &&
            createElement(Preview, {
              key: "inspector",
              result: snapshot,
              mode,
            }),
        ]),
      ),
    );
  await render("chart");
  expect(api).toHaveBeenCalledTimes(1);
  const [url, options] = vi.mocked(api).mock.calls[0];
  expect(url).toMatch(/\/chart$/);
  await render("histogram", true);
  expect(options?.signal?.aborted).toBe(true);
  expect(api).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api).mock.calls[1][0]).toMatch(/\/table$/);
  expect(host.textContent).toBe("pendingpending");
  await act(async () =>
    chartRead.reject(new Error("chart accepts at most 5000 rows")),
  );
  expect(host.textContent).toBe("pendingpending");
  await act(async () =>
    tableRead.resolve({
      rows: Array.from({ length: 6000 }, (_, i) => [i]),
      result: snapshot,
    }),
  );
  expect(host.textContent).toBe("60006000");
  await render("metadata");
  expect(api).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe("0");
});
