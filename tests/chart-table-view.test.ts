// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ResultView, { ChartSettings } from "../src/client/board/ResultView";
import {
  createTableSpec,
  tableReshapeIds,
} from "../src/client/board/tableModel";
import type { ResultSet, TableSpec } from "../src/shared/types";
import { api, getResultRows } from "../src/client/api";

const rendered = vi.hoisted(() => ({ option: undefined as any }));
vi.mock("../src/client/board/ChartCanvas", () => ({
  default: ({ option, label }: any) => {
    rendered.option = option;
    return createElement("div", { role: "img", "aria-label": label });
  },
}));
vi.mock("../src/client/api", () => ({ api: vi.fn(), getResultRows: vi.fn() }));
vi.mock("../src/client/components/Select", () => ({
  Select: (props: any) =>
    createElement(
      "select",
      {
        "aria-label": props["aria-label"],
        value: props.value,
        onChange: (event: any) => props.onValueChange(event.target.value),
      },
      props.options.map((option: any) =>
        createElement(
          "option",
          {
            key: option.value,
            value: option.value,
          },
          option.label,
        ),
      ),
    ),
}));

let root: Root;
let host: HTMLDivElement;
let result: ResultSet;
const rows = [
  ["B", 20, 200],
  ["A", 10, 100],
  ["C", 30, 300],
];
const chart = { kind: "bar" as const, x: "city", y: ["jan"], legend: true };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rendered.option = undefined;
  result = {
    id: crypto.randomUUID(),
    columns: [
      { id: "city", name: "Город", type: "String" },
      { id: "jan", name: "Январь", type: "UInt64" },
      { id: "feb", name: "Февраль", type: "UInt64" },
    ],
    rowCount: 3,
    byteCount: 100,
    createdAt: "2026-11-05",
    source: { connectionId: "connection", sql: "select city, jan, feb" },
  };
  vi.mocked(getResultRows)
    .mockReset()
    .mockResolvedValue({ result, rows: rows.slice(0, 1), offset: 0, total: 3 });
  vi.mocked(api).mockReset().mockResolvedValue({ result, rows });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(table: TableSpec, onMetadata = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(ResultView, {
        id: result.id,
        view: "chart",
        chart,
        table,
        onMetadata,
      }),
    ),
  );
}
const pointValues = () =>
  rendered.option.series.flatMap((series: any) =>
    series.data.map(
      (point: any) => (Array.isArray(point) ? point : point.value)[1],
    ),
  );

it("updates presentation chart contrast when the slide background changes without rereading data", async () => {
  const table = createTableSpec(result.columns);
  const show = async (presentationBackground: string) =>
    act(async () =>
      root.render(
        createElement(ResultView, {
          id: result.id,
          view: "chart",
          chart,
          table,
          presentationBackground,
        }),
      ),
    );
  await show("#ffffff");
  expect(rendered.option.xAxis.axisLabel.color).toBe("#475569");
  const reads = vi.mocked(api).mock.calls.length;
  const resultReads = vi.mocked(getResultRows).mock.calls.length;
  const seriesColors = rendered.option.series.map(
    (item: any) => item.itemStyle,
  );
  await show("#202124");
  expect(rendered.option.xAxis.axisLabel.color).toBe("#a9adb1");
  expect(rendered.option.series.map((item: any) => item.itemStyle)).toEqual(
    seriesColors,
  );
  expect(api).toHaveBeenCalledTimes(reads);
  expect(getResultRows).toHaveBeenCalledTimes(resultReads);
});

it("charts the filtered and sorted complete table, then updates without rereading the snapshot", async () => {
  const table: TableSpec = {
    ...createTableSpec(result.columns),
    filters: [{ column: "jan", op: "gte", value: "20" }],
    sort: { column: "jan", direction: "desc" },
  };
  const onMetadata = vi.fn();
  await render(table, onMetadata);
  expect(pointValues()).toEqual([30, 20]);
  expect(api).toHaveBeenCalledWith(
    expect.stringMatching(/\/table$/),
    expect.anything(),
  );
  expect(onMetadata).toHaveBeenCalledWith(result);
  const reads = vi.mocked(api).mock.calls.length;
  await render({
    ...table,
    filters: [{ column: "city", op: "eq", value: "A" }],
  });
  expect(pointValues()).toEqual([10]);
  expect(api).toHaveBeenCalledTimes(reads);
});

it("uses the reshaped schema and renamed fields in chart settings", async () => {
  const table: TableSpec = {
    ...createTableSpec(result.columns),
    reshape: {
      kind: "melt",
      columns: ["jan", "feb"],
      keyName: "Месяц",
      valueName: "Продажи",
    },
    columns: { city: { label: "Место" } },
  };
  await act(async () =>
    root.render(
      createElement(ChartSettings, {
        result,
        table,
        spec: chart,
        onChange: vi.fn(),
      }),
    ),
  );
  const x = host.querySelector<HTMLSelectElement>('[aria-label="Ось X"]')!;
  expect([...x.options].map((o) => o.textContent)).toEqual([
    "Место",
    "Месяц",
    "Продажи",
  ]);
  expect(host.querySelector('input[type="checkbox"]:checked')).not.toBeNull();
  expect(host.textContent).not.toContain("Январь");
  expect([...x.options].map((o) => o.value)).toContain(
    tableReshapeIds(result.columns).value,
  );
});

it("shows reshape conflicts directly instead of drawing the raw snapshot", async () => {
  await render({
    ...createTableSpec(result.columns),
    reshape: { kind: "pivot", rows: [], column: "city", value: "jan" },
  });
  expect(host.querySelector('[role="img"]')).not.toBeNull();
  // The same category with no row key would overwrite a cell.
  result = { ...result, id: crypto.randomUUID() };
  vi.mocked(getResultRows).mockResolvedValue({
    result,
    rows,
    offset: 0,
    total: 3,
  });
  vi.mocked(api).mockResolvedValue({ result, rows: [...rows, ["B", 99, 999]] });
  await render({
    ...createTableSpec(result.columns),
    reshape: { kind: "pivot", rows: [], column: "city", value: "jan" },
  });
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toMatch(/конфликт/i);
  expect(
    alert?.querySelector(".error-hint")?.textContent ?? alert?.textContent,
  ).toMatch(/ключ/i);
  expect(host.querySelector('[role="img"]')).toBeNull();
});

it("shows an empty filtered pivot without demanding columns that have no values yet", async () => {
  await render({
    ...createTableSpec(result.columns),
    filters: [{ column: "city", op: "eq", value: "absent" }],
    reshape: { kind: "pivot", rows: ["city"], column: "feb", value: "jan" },
  });
  expect(host.textContent).toContain("Нет строк, подходящих под фильтры.");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
