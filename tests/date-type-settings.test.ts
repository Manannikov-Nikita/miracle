// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartSettings } from "../src/client/board/ResultView";
import TableSettings from "../src/client/board/TableSettings";
import {
  chartTableData,
  tableChartSeries,
} from "../src/client/board/chartTableModel";
import { buildTable, createTableSpec } from "../src/shared/tableModel";
import { tableSpecSchema } from "../src/shared/table-schema";
import { api } from "../src/client/api";
import type { ChartSpec, ResultSet, TableSpec } from "../src/shared/types";

vi.mock("../src/client/api", () => ({ api: vi.fn(), getResultRows: vi.fn() }));
vi.mock("../src/client/board/ChartCanvas", () => ({ default: () => null }));
vi.mock("../src/client/components/Select", () => ({
  Select: (props: any) =>
    createElement(
      "select",
      {
        "aria-label": props["aria-label"],
        value: props.value,
        disabled: props.disabled,
        onChange: (event: any) => props.onValueChange(event.target.value),
      },
      props.options.map((option: any) =>
        createElement(
          "option",
          { key: option.value, value: option.value },
          option.label,
        ),
      ),
    ),
}));

const chart: ChartSpec = {
  kind: "line",
  x: "date",
  y: ["value"],
  legend: true,
  sort: "asc",
};
const rows = [
  ["02.01.2025", 2, "hidden"],
  ["31.12.2024", 1, "hidden"],
];
let root: Root;
let host: HTMLDivElement;
let result: ResultSet;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  result = {
    id: crypto.randomUUID(),
    columns: [
      { id: "date", name: "Дата", type: "String" },
      { id: "value", name: "Значение", type: "UInt32" },
      { id: "extra", name: "Служебный", type: "String" },
    ],
    rowCount: rows.length,
    byteCount: 100,
    createdAt: "2026-11-09",
    source: { connectionId: "connection", sql: "select date, value, extra" },
  };
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

function savedTable(): TableSpec {
  return {
    ...createTableSpec(result.columns),
    columns: {
      date: {
        label: "День заказа",
        width: 160,
        format: "text",
        prefix: "Дата: ",
      },
      value: { decimals: 2, format: "number" },
      extra: { hidden: true },
    },
    sort: { column: "date", direction: "asc" },
    filters: [{ column: "value", op: "gte", value: "1" }],
    order: ["date", "value", "extra"],
    density: "comfortable",
    wrap: true,
  };
}
async function choose(label: string, value: string) {
  const control = host.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  expect(control).not.toBeNull();
  await act(async () => {
    control!.value = value;
    control!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("date type settings persistence", () => {
  it("changes the chart category type while preserving the original table schema and settings", async () => {
    const original = savedTable();
    let current = original;
    const onChange = vi.fn();
    const render = () =>
      root.render(
        createElement(ChartSettings, {
          result,
          table: current,
          spec: chart,
          onChange,
          onTableChange: (table) => {
            current = tableSpecSchema.parse(JSON.parse(JSON.stringify(table)));
            render();
          },
        }),
      );
    await act(async () => render());
    await choose("Тип данных X", "date");
    expect(current).toEqual({
      ...original,
      columns: {
        ...original.columns,
        date: { ...original.columns!.date, dataType: "date" },
      },
    });
    expect(original.columns!.date.dataType).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
    const prepared = chartTableData(result.columns, rows, current);
    expect(
      tableChartSeries(prepared, chart)[0].data.map(([date]) => date),
    ).toEqual(["31.12.2024", "02.01.2025"]);
    expect(
      host.querySelector<HTMLSelectElement>('[aria-label="Тип данных X"]')!
        .value,
    ).toBe("date");
  });

  it("creates the first table settings from all original columns and keeps legacy hidden columns", async () => {
    const visibleColumns = ["date", "value"];
    const save = vi.fn();
    await act(async () =>
      root.render(
        createElement(ChartSettings, {
          result,
          visibleColumns,
          spec: chart,
          onChange: vi.fn(),
          onTableChange: save,
        }),
      ),
    );
    await choose("Тип данных X", "date");
    expect(save).toHaveBeenCalledTimes(1);
    const persisted = tableSpecSchema.parse(save.mock.calls[0][0]);
    const expected = createTableSpec(result.columns, visibleColumns);
    expect(persisted).toEqual({
      ...expected,
      columns: {
        ...expected.columns,
        date: { ...expected.columns!.date, dataType: "date" },
      },
    });
    expect(
      buildTable(result.columns, rows, persisted).columns.map(({ id }) => id),
    ).toEqual(visibleColumns);
  });

  it("round-trips the table column type independently of display formatting", async () => {
    const original = savedTable();
    let current = original;
    const render = () =>
      root.render(
        createElement(TableSettings, {
          result,
          spec: current,
          onChange: (table) => {
            current = tableSpecSchema.parse(JSON.parse(JSON.stringify(table)));
            render();
          },
        }),
      );
    await act(async () => render());
    await choose("Тип данных", "date");
    expect(current.columns!.date).toEqual({
      ...original.columns!.date,
      dataType: "date",
    });
    expect(
      buildTable(result.columns, rows, current).rows.map(([date]) => date),
    ).toEqual(["31.12.2024", "02.01.2025"]);
    expect(
      host.querySelector<HTMLSelectElement>('[aria-label="Формат"]')!.value,
    ).toBe("text");
    await choose("Тип данных", "auto");
    expect(current).toEqual({
      ...original,
      columns: {
        ...original.columns,
        date: { ...original.columns!.date, dataType: "auto" },
      },
    });
    expect(
      buildTable(result.columns, rows, current).rows.map(([date]) => date),
    ).toEqual(["02.01.2025", "31.12.2024"]);
  });
});
