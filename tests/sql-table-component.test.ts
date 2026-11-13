// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getGridApi } from "ag-grid-community";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createEmptyVisualTable,
  type VisualTableResult,
  type VisualTableSpec,
} from "../src/shared/visual-table";
import SqlTableView from "../src/client/board/SqlTableView";

const evaluate = vi.hoisted(() => vi.fn());
vi.mock("../src/client/api", () => ({ evaluateVisualTable: evaluate }));
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange, options }: any) =>
    createElement("textarea", {
      "aria-label": options.ariaLabel,
      value,
      readOnly: options.readOnly,
      onChange: (event: any) => onChange(event.target.value),
    }),
}));
let host: HTMLDivElement, root: Root, current: VisualTableSpec;
function Harness({
  editable = true,
  onKeyDown,
  initialSpec,
}: {
  editable?: boolean;
  onKeyDown?: () => void;
  initialSpec?: VisualTableSpec;
}) {
  const [table, setTable] = useState(
    () => initialSpec ?? createEmptyVisualTable(),
  );
  current = table;
  return createElement(
    "div",
    { onKeyDown, className: "board-workspace" },
    createElement(SqlTableView, { spec: table, editable, onChange: setTable }),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  evaluate.mockImplementation(
    async ({
      table,
    }: {
      table: VisualTableSpec;
    }): Promise<VisualTableResult> => ({
      columns: table.columns,
      rows: [
        ...(table.sourceResultSetId
          ? [
              {
                id: `${table.sourceResultSetId}:0`,
                values: { price: "10", total: "20" },
              },
            ]
          : []),
        ...(table.rows ?? []),
      ],
      summaries: {},
      sourceRowCount: table.rows?.length ?? 0,
      totalRowCount: table.rows?.length ?? 0,
      offset: 0,
      limit: 500,
      sql: "SELECT * FROM source",
      parameters: [],
      elapsedMs: 1,
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.title === label,
  )!;
it("adds a manual row and keeps table undo and redo scoped to that definition", async () => {
  await act(async () => root.render(createElement(Harness)));
  const before = current.rows!.length;
  await act(async () => button("Добавить строку").click());
  expect(current.rows).toHaveLength(before + 1);
  await act(async () => button("Отменить изменение таблицы").click());
  expect(current.rows).toHaveLength(before);
  await act(async () => button("Повторить изменение таблицы").click());
  expect(current.rows).toHaveLength(before + 1);
});
it("keeps the read-only table free of mutating controls", async () => {
  await act(async () =>
    root.render(createElement(Harness, { editable: false })),
  );
  expect(button("Добавить строку")).toBeUndefined();
  expect(button("Добавить столбец")).toBeUndefined();
  expect(button("Отменить изменение таблицы")).toBeUndefined();
  expect(host.querySelector('[aria-label="Тип нового столбца"]')).toBeNull();
});
it("does not let a cell-level keyboard event bubble to the board", async () => {
  const key = vi.fn();
  await act(async () =>
    root.render(createElement(Harness, { onKeyDown: key })),
  );
  const wrapper = host.querySelector(".board-sql-table")!;
  const cell = document.createElement("div");
  cell.tabIndex = 0;
  wrapper.append(cell);
  await act(async () =>
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(key).not.toHaveBeenCalled();
});

it("opens the clicked column in a local sidebar without recreating the grid and preserves switched drafts", async () => {
  await act(async () => root.render(createElement(Harness)));
  const grid = host.querySelector(".ag-root-wrapper");
  const [first, second] = current.columns;
  await act(async () => button(`Редактировать столбец ${first.name}`).click());
  const sidebar = host.querySelector('[aria-label="Редактор столбца"]')!;
  expect(sidebar).not.toBeNull();
  expect(sidebar.closest(".react-flow__viewport")).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector(".ag-root-wrapper")).toBe(grid);
  const name = sidebar.querySelector<HTMLInputElement>(
    '[aria-label="Название столбца"]',
  )!;
  expect(name.value).toBe(first.name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(name, "Черновик названия");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(`Редактировать столбец ${second.name}`).click());
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Название столбца"]')!
      .value,
  ).toBe(second.name);
  await act(async () => button(`Редактировать столбец ${first.name}`).click());
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Название столбца"]')!
      .value,
  ).toBe("Черновик названия");
  expect(current.columns[0].name).toBe(first.name);
  expect(host.querySelector(".ag-root-wrapper")).toBe(grid);
});
it("sorts without opening a sidebar and Escape closes only the column editor", async () => {
  await act(async () => root.render(createElement(Harness)));
  const first = current.columns[0];
  await act(async () => button(`Сортировка: ${first.name}`).click());
  expect(current.sort?.columnId).toBe(first.id);
  expect(host.querySelector('[aria-label="Редактор столбца"]')).toBeNull();
  await act(async () => button("Развернуть таблицу").click());
  await act(async () => button(`Редактировать столбец ${first.name}`).click());
  const sidebar = host.querySelector('[aria-label="Редактор столбца"]')!;
  expect(sidebar.closest(".board-table-surface-expanded")).not.toBeNull();
  await act(async () =>
    sidebar.querySelector("input")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(host.querySelector('[aria-label="Редактор столбца"]')).toBeNull();
  expect(host.querySelector(".board-table-surface-expanded")).not.toBeNull();
});
it("keeps one column editor per board and preserves drafts when switching tables", async () => {
  const tables = [createEmptyVisualTable(), createEmptyVisualTable()];
  await act(async () =>
    root.render(
      createElement(
        "div",
        { className: "board-workspace" },
        ...tables.map((spec, key) =>
          createElement(SqlTableView, {
            key,
            spec,
            editable: true,
            onChange: vi.fn(),
          }),
        ),
      ),
    ),
  );
  const grids = host.querySelectorAll(".board-sql-table");
  const openFirst = (index: number) =>
    grids[index]
      .querySelector<HTMLButtonElement>("[data-column-name]")!
      .click();
  await act(async () => openFirst(0));
  const name = host.querySelector<HTMLInputElement>(
    '[aria-label="Название столбца"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(name, "Черновик первой таблицы");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => openFirst(1));
  expect(host.querySelectorAll('[aria-label="Редактор столбца"]')).toHaveLength(
    1,
  );
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Название столбца"]')!
      .value,
  ).toBe(tables[1].columns[0].name);
  await act(async () => openFirst(0));
  expect(host.querySelectorAll('[aria-label="Редактор столбца"]')).toHaveLength(
    1,
  );
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Название столбца"]')!
      .value,
  ).toBe("Черновик первой таблицы");
  await act(async () =>
    grids[1].querySelector<HTMLButtonElement>(".sql-table-add-column")!.click(),
  );
  expect(host.querySelectorAll('[aria-label="Редактор столбца"]')).toHaveLength(
    1,
  );
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Название столбца"]')!
      .value,
  ).toBe(`Столбец ${tables[1].columns.length + 1}`);
  await act(async () => openFirst(0));
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Название столбца"]')!
      .value,
  ).toBe("Черновик первой таблицы");
});
it("keeps column editors in separate board panes independent", async () => {
  await act(async () =>
    root.render(
      createElement(
        "div",
        null,
        createElement(Harness, { key: "first" }),
        createElement(Harness, { key: "second" }),
      ),
    ),
  );
  for (const board of host.querySelectorAll(".board-workspace")) {
    await act(async () =>
      board.querySelector<HTMLButtonElement>("[data-column-name]")!.click(),
    );
  }
  expect(host.querySelectorAll('[aria-label="Редактор столбца"]')).toHaveLength(
    2,
  );
});
it("expands into the owning board without a dialog and restores one grid", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => button("Развернуть таблицу").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const surface = host.querySelector(".board-table-surface-expanded")!;
  expect(surface).not.toBeNull();
  expect(surface.closest(".board-workspace")).not.toBeNull();
  expect(surface.querySelector(".ag-root-wrapper")).not.toBeNull();
  expect(document.querySelectorAll(".ag-root-wrapper")).toHaveLength(1);
  await act(async () => button("Вернуться на доску").click());
  expect(host.querySelector(".board-table-surface-expanded")).toBeNull();
  expect(host.querySelectorAll(".ag-root-wrapper")).toHaveLength(1);
});
const sqlSpec = (): VisualTableSpec => ({
  version: 1,
  sourceResultSetId: "11111111-1111-4111-8111-111111111111",
  sourceSchema: "test",
  columns: [
    { id: "price", name: "Цена", type: "number", sourceColumnId: "price" },
    { id: "total", name: "Итог", type: "number", formula: "Цена * 2" },
  ],
  rows: [{ id: "manual", values: { price: "30" } }],
  edits: [],
});
it("protects SQL snapshot cells from editing and paste but allows manual cells", async () => {
  await act(async () =>
    root.render(createElement(Harness, { initialSpec: sqlSpec() })),
  );
  const api = getGridApi(host.querySelector<HTMLElement>(".ag-root-wrapper")!)!;
  await act(async () => api.startEditingCell({ rowIndex: 0, colKey: "price" }));
  expect(api.getEditingCells()).toHaveLength(0);
  const source = host.querySelector('.ag-row[row-index="0"] [col-id="price"]')!;
  expect(source.classList.contains("sql-table-source-cell")).toBe(true);
  await act(async () => api.setFocusedCell(0, "price"));
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "999" },
  });
  await act(async () => source.dispatchEvent(paste));
  expect(current.edits).toHaveLength(0);
  await act(async () => api.startEditingCell({ rowIndex: 1, colKey: "price" }));
  expect(api.getEditingCells()).toHaveLength(1);
  await act(async () => api.stopEditing(true));
  await act(async () => api.setFocusedCell(1, "price"));
  const localPaste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(localPaste, "clipboardData", {
    value: { getData: () => "40" },
  });
  await act(async () =>
    host.querySelector(".board-sql-table")!.dispatchEvent(localPaste),
  );
  expect(current.edits).toContainEqual({
    rowId: "manual",
    columnId: "price",
    value: "40",
  });
});
it("adds a local row after a SQL snapshot using edge controls and supports undo", async () => {
  await act(async () =>
    root.render(createElement(Harness, { initialSpec: sqlSpec() })),
  );
  expect(
    button("Добавить строку").closest(".sql-table-add-row"),
  ).not.toBeNull();
  expect(
    button("Добавить столбец").closest(".sql-table-add-column"),
  ).not.toBeNull();
  expect(button("Добавить столбец").closest(".sql-table-toolbar")).toBeNull();
  await act(async () => button("Добавить строку").click());
  expect(current.rows).toHaveLength(2);
  expect(current.sourceResultSetId).toBe(sqlSpec().sourceResultSetId);
  await act(async () => button("Отменить изменение таблицы").click());
  expect(current.rows).toHaveLength(1);
});

it("reveals a new row after a filtered paginated SQL snapshot and undo restores the view", async () => {
  evaluate.mockImplementation(
    async ({
      table,
      offset = 0,
    }: {
      table: VisualTableSpec;
      offset?: number;
    }) => {
      const snapshot = Array.from({ length: 501 }, (_, i) => ({
        id: `${table.sourceResultSetId}:${i}`,
        values: { price: String(i) },
      }));
      const all = [...snapshot, ...(table.rows ?? [])];
      const visible = table.filters?.length ? snapshot.slice(0, 1) : all;
      return {
        columns: table.columns,
        rows: visible.slice(offset, offset + 500),
        summaries: {},
        sourceRowCount: all.length,
        totalRowCount: visible.length,
        offset,
        limit: 500,
        sql: "SELECT * FROM source",
        parameters: [],
        elapsedMs: 1,
      };
    },
  );
  const original = {
    ...sqlSpec(),
    filters: [{ columnId: "price", op: "gt" as const, value: "100" }],
    sort: { columnId: "price", direction: "desc" as const },
  };
  await act(async () =>
    root.render(createElement(Harness, { initialSpec: original })),
  );
  await act(async () => button("Добавить строку").click());
  const api = getGridApi(host.querySelector<HTMLElement>(".ag-root-wrapper")!)!;
  expect(current.rows).toHaveLength(2);
  expect(current.filters).toBeUndefined();
  expect(current.sort).toBeUndefined();
  expect(evaluate.mock.calls.at(-1)![0].offset).toBe(500);
  expect(
    api.getDisplayedRowAtIndex(api.getFocusedCell()!.rowIndex)?.data?.id,
  ).toBe(current.rows!.at(-1)!.id);
  expect(host.textContent).toContain("Фильтры и сортировка сняты");
  await act(async () => api.stopEditing(true));
  await act(async () => button("Отменить изменение таблицы").click());
  expect(current.rows).toHaveLength(1);
  expect(current.filters).toEqual(original.filters);
  expect(current.sort).toEqual(original.sort);
});
