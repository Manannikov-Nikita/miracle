// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VisualTableSpec } from "../src/shared/visual-table";
import SqlTableColumnEditor, {
  type SqlTableColumnDraft,
} from "../src/client/board/SqlTableColumnEditor";

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

const table = (): VisualTableSpec => ({
  version: 1,
  columns: [{ id: "quantity", name: "Количество", type: "number" }],
  rows: [{ id: "row-1", values: { quantity: "3" } }],
  edits: [],
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  evaluate.mockReset().mockResolvedValue({ rows: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function field(label: string) {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
}
async function fill(label: string, value: string) {
  const element = field(label);
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (element) => element.textContent === name,
  )!;

it("requires a valid expression and saves only after its table evaluates", async () => {
  const save = vi.fn();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec: table(),
        onSave: save,
        onClose: vi.fn(),
      }),
    ),
  );
  await act(async () => button("Добавить столбец").click());
  expect(save).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "выражение",
  );
  await fill("Название столбца", "Стоимость");
  await fill("SQL-выражение столбца", '"Количество" * 10');
  await act(async () => button("Добавить столбец").click());
  expect(evaluate).toHaveBeenCalledOnce();
  expect(evaluate.mock.calls[0][0].table.columns).toHaveLength(2);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Стоимость",
      formula: '"Количество" * 10',
      type: "number",
    }),
  );
});

it("keeps the draft when DuckDB rejects the expression and lets it be corrected", async () => {
  const save = vi.fn();
  evaluate.mockRejectedValueOnce(new Error("Неверный тип результата"));
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec: table(),
        onSave: save,
        onClose: vi.fn(),
      }),
    ),
  );
  await fill("SQL-выражение столбца", 'lower("Количество")');
  await act(async () => button("Добавить столбец").click());
  expect(save).not.toHaveBeenCalled();
  expect(field("SQL-выражение столбца").value).toBe('lower("Количество")');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Неверный тип результата",
  );
  await fill("SQL-выражение столбца", '"Количество" + 1');
  await act(async () => button("Добавить столбец").click());
  expect(save).toHaveBeenCalledOnce();
});

it("cancels an in-flight validation without applying its late result", async () => {
  const save = vi.fn(),
    close = vi.fn();
  let resolve!: (value: unknown) => void;
  evaluate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec: table(),
        onSave: save,
        onClose: close,
      }),
    ),
  );
  await fill("SQL-выражение столбца", '"Количество" * 2');
  await act(async () => button("Добавить столбец").click());
  const signal = evaluate.mock.calls[0][1] as AbortSignal;
  await act(async () => button("Отмена").click());
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ rows: [] }));
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it("keeps source expressions and types read-only while allowing their display name", async () => {
  const spec = table();
  spec.sourceResultSetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  spec.sourceSchema = "source";
  delete spec.rows;
  spec.columns[0].sourceColumnId = "original";
  const save = vi.fn();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec,
        columnId: "quantity",
        onSave: save,
        onClose: vi.fn(),
      }),
    ),
  );
  expect(field("SQL-выражение столбца").readOnly).toBe(true);
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="Тип столбца"]')
      ?.disabled,
  ).toBe(true);
  await fill("Название столбца", "Штук");
  await act(async () => button("Сохранить").click());
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Штук",
      sourceColumnId: "original",
      type: "number",
    }),
  );
});

it("renames references in the validation candidate and preserves an empty manual expression", async () => {
  const spec = table();
  spec.columns.push({
    id: "total",
    name: "Итого",
    type: "number",
    formula: '"Количество" * 2',
  });
  const save = vi.fn();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec,
        columnId: "quantity",
        onSave: save,
        onClose: vi.fn(),
      }),
    ),
  );
  await fill("Название столбца", "Штук");
  await act(async () => button("Сохранить").click());
  expect(evaluate.mock.calls[0][0].table.columns[1].formula).toContain("Штук");
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "quantity",
      name: "Штук",
      formula: undefined,
    }),
  );
});

it("rejects unsupported syntax before requesting evaluation and cancels the draft with Escape", async () => {
  const save = vi.fn(),
    close = vi.fn();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec: table(),
        onSave: save,
        onClose: close,
      }),
    ),
  );
  await fill("SQL-выражение столбца", "SELECT 1");
  await act(async () => button("Добавить столбец").click());
  expect(evaluate).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () =>
    field("SQL-выражение столбца").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(close).toHaveBeenCalledOnce();
});

it("ignores an obsolete failure after the expression changes", async () => {
  let reject!: (failure: Error) => void;
  evaluate.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec: table(),
        onSave: vi.fn(),
        onClose: vi.fn(),
      }),
    ),
  );
  await fill("SQL-выражение столбца", '"Количество" * 2');
  await act(async () => button("Добавить столбец").click());
  await fill("SQL-выражение столбца", '"Количество" * 3');
  await act(async () => reject(new Error("Ошибка предыдущего выражения")));
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(field("SQL-выражение столбца").value).toBe('"Количество" * 3');
});

it("keeps a referenced column and lists the dependent formulas instead of deleting it", async () => {
  const spec = table();
  spec.columns.push({
    id: "total",
    name: "Стоимость",
    type: "number",
    formula: '"Количество" * 10',
  });
  const remove = vi.fn(),
    close = vi.fn();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec,
        columnId: "quantity",
        onSave: vi.fn(),
        onClose: close,
        onRemove: remove,
      }),
    ),
  );
  await act(async () => button("Удалить столбец").click());
  expect(remove).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="complementary"]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Стоимость",
  );
});

it("aborts pending validation before deleting an unreferenced column", async () => {
  const spec = table();
  spec.columns.push({
    id: "total",
    name: "Стоимость",
    type: "number",
    formula: "10",
  });
  const remove = vi.fn(),
    save = vi.fn();
  let resolve!: (value: unknown) => void;
  evaluate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec,
        columnId: "total",
        onSave: save,
        onClose: vi.fn(),
        onRemove: remove,
      }),
    ),
  );
  await act(async () => button("Сохранить").click());
  const signal = evaluate.mock.calls[0][1] as AbortSignal;
  await act(async () => button("Удалить столбец").click());
  expect(signal.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith("total");
  await act(async () => resolve({ rows: [] }));
  await act(async () => button("Сохранить").click());
  expect(save).not.toHaveBeenCalled();
  expect(evaluate).toHaveBeenCalledOnce();
});

it("rewrites an unchanged self reference before validating a renamed formula", async () => {
  const spec = table();
  spec.columns[0].formula = '"Количество" + 1';
  evaluate.mockRejectedValueOnce(
    new Error("Циклическая зависимость между формулами столбцов."),
  );
  const save = vi.fn();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec,
        columnId: "quantity",
        onSave: save,
        onClose: vi.fn(),
      }),
    ),
  );
  await fill("Название столбца", "Штук");
  await act(async () => button("Сохранить").click());
  expect(evaluate.mock.calls[0][0].table.columns[0].formula).toBe("[Штук] + 1");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Циклическая",
  );
  expect(save).not.toHaveBeenCalled();
});

it("opens a nonmodal side editor for the selected column without locking other controls", async () => {
  const outside = vi.fn();
  await act(async () =>
    root.render(
      createElement(
        "div",
        null,
        createElement("button", { onClick: outside }, "Другой столбец"),
        createElement(SqlTableColumnEditor, {
          spec: table(),
          columnId: "quantity",
          onSave: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    ),
  );
  const panel = host.querySelector(
    '[role="complementary"][aria-label="Редактор столбца"]',
  );
  expect(panel).not.toBeNull();
  expect(panel?.querySelector("h2")?.textContent).toBe("Количество");
  expect(document.querySelector('[role="dialog"],.modal-backdrop')).toBeNull();
  expect(document.body.style.overflow).toBe("");
  expect(document.activeElement).toBe(field("Название столбца"));
  await act(async () => button("Другой столбец").click());
  expect(outside).toHaveBeenCalledOnce();
});

it("reports changed drafts and restores them when the column editor is reopened", async () => {
  const drafts: SqlTableColumnDraft[] = [];
  const spec = table();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec,
        columnId: "quantity",
        onSave: vi.fn(),
        onClose: vi.fn(),
        onDraftChange: (draft: SqlTableColumnDraft) => drafts.push(draft),
      }),
    ),
  );
  expect(drafts).toHaveLength(0);
  await fill("Название столбца", "Черновик");
  await fill("SQL-выражение столбца", "10 * 2");
  const cached = drafts.at(-1)!;
  expect(cached).toEqual({
    name: "Черновик",
    formula: "10 * 2",
    type: "number",
    summary: "none",
  });
  await act(async () => root.render(null));
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec,
        columnId: "quantity",
        draft: cached,
        onSave: vi.fn(),
        onClose: vi.fn(),
        onDraftChange: (draft: SqlTableColumnDraft) => drafts.push(draft),
      }),
    ),
  );
  expect(field("Название столбца").value).toBe("Черновик");
  expect(field("SQL-выражение столбца").value).toBe("10 * 2");
  expect(drafts).toHaveLength(2);
});

it("closes the side editor with Escape from its header and does not bubble to the board", async () => {
  const close = vi.fn(),
    boardKey = vi.fn();
  await act(async () =>
    root.render(
      createElement(
        "div",
        { onKeyDown: boardKey },
        createElement(SqlTableColumnEditor, {
          spec: table(),
          columnId: "quantity",
          onSave: vi.fn(),
          onClose: close,
        }),
      ),
    ),
  );
  const panel = host.querySelector('[role="complementary"]')!;
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => panel.querySelector("button")!.dispatchEvent(escape));
  expect(close).toHaveBeenCalledOnce();
  expect(escape.defaultPrevented).toBe(true);
  expect(boardKey).not.toHaveBeenCalled();
});

it("leaves Escape consumed by the SQL editor alone", async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      createElement(SqlTableColumnEditor, {
        spec: table(),
        columnId: "quantity",
        onSave: vi.fn(),
        onClose: close,
      }),
    ),
  );
  const input = field("SQL-выражение столбца");
  input.addEventListener("keydown", (event) => event.preventDefault());
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(close).not.toHaveBeenCalled();
});
