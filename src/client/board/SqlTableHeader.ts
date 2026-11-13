import type { IHeaderParams } from "ag-grid-community";
import type { VisualTableColumn } from "../../shared/visual-table";

export type SqlTableHeaderOptions = {
  definition: VisualTableColumn;
  editable: boolean;
  direction?: "asc" | "desc";
  rename: (name: string) => void;
  formula: (formula: string) => void;
  summary: (summary: NonNullable<VisualTableColumn["summary"]>) => void;
  sort: () => void;
  remove?: () => void;
  register?: (header: SqlTableHeader) => void;
  unregister?: (header: SqlTableHeader) => void;
};
type HeaderParams = IHeaderParams & SqlTableHeaderOptions;
const summaries = {
  none: "Без итога",
  sum: "Σ Сумма",
  avg: "Среднее",
  min: "Минимум",
  max: "Максимум",
  count: "Количество",
};

/** Keep the same input DOM across commits, so blur cannot destroy the next click target. */
export class SqlTableHeader {
  private element = document.createElement("div");
  private params!: HeaderParams;
  private name = document.createElement("input");
  private formula?: HTMLInputElement;
  private summary?: HTMLSelectElement;
  private sort?: HTMLButtonElement;
  private remove?: HTMLButtonElement;
  private readonlyFormula?: HTMLSpanElement;
  private pendingCommits = new Map<HTMLInputElement, { timer: number; commit: () => void }>();

  init(params: HeaderParams) {
    this.params = params;
    this.element.className = "sql-table-column-header";
    const title = document.createElement("div");
    title.className = "sql-table-column-title";
    const name = this.name;
    name.maxLength = 200;
    name.readOnly = !params.editable;
    name.dataset.columnName = params.definition.id;
    name.addEventListener("blur", () => {
      if (!this.params.editable) return;
      const next = name.value.trim();
      this.commitAfterFocus(name, () => {
        if (next && next !== this.params.definition.name)
          this.params.rename(next);
        else if (document.activeElement !== name)
          name.value = this.params.definition.name;
      });
    });
    name.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        name.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelCommit(name);
        name.value = this.params.definition.name;
        name.blur();
      }
    });
    title.append(name);
    this.element.append(title);
    if (params.editable) {
      const sort = (this.sort = document.createElement("button"));
      sort.type = "button";
      sort.className = "sql-table-column-sort";
      sort.title = "Сортировка по столбцу";
      sort.addEventListener("click", () => this.params.sort());
      title.append(sort);
      const remove = (this.remove = document.createElement("button"));
      remove.type = "button";
      remove.textContent = "×";
      remove.className = "sql-table-column-remove";
      remove.addEventListener("click", () => this.params.remove?.());
      title.append(remove);
      const line = document.createElement("label");
      line.className = "sql-table-column-formula";
      const sign = document.createElement("span");
      sign.textContent = "ƒ";
      sign.setAttribute("aria-hidden", "true");
      const input = (this.formula = document.createElement("input"));
      input.maxLength = 2000;
      input.dataset.columnFormula = params.definition.id;
      input.placeholder = "Формула…";
      input.title =
        "Выражение для всех строк, например [Количество] * [Цена]. Enter — применить, Esc — отменить.";
      input.addEventListener("blur", () => {
        if (!this.params.editable) return;
        const next = input.value.trim();
        this.commitAfterFocus(input, () => {
          if (next !== (this.params.definition.formula ?? ""))
            this.params.formula(next);
        });
      });
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.cancelCommit(input);
          input.value = this.params.definition.formula ?? "";
          input.blur();
        }
      });
      line.append(sign, input);
      this.element.append(line);
      const summary = (this.summary = document.createElement("select"));
      for (const [value, label] of Object.entries(summaries)) {
        if (
          params.definition.type !== "number" &&
          (value === "sum" || value === "avg")
        )
          continue;
        summary.add(new Option(label, value));
      }
      summary.addEventListener("change", () =>
        this.params.summary(
          summary.value as NonNullable<VisualTableColumn["summary"]>,
        ),
      );
      this.element.append(summary);
    } else {
      this.readonlyFormula = document.createElement("span");
      this.readonlyFormula.className = "sql-table-readonly-formula";
      this.element.append(this.readonlyFormula);
    }
    this.element.addEventListener("pointerdown", (event) =>
      event.stopPropagation(),
    );
    this.sync(params.definition);
    params.register?.(this);
  }
  private cancelCommit(input: HTMLInputElement) {
    const pending = this.pendingCommits.get(input);
    if (pending) window.clearTimeout(pending.timer);
    this.pendingCommits.delete(input);
  }
  private commitAfterFocus(input: HTMLInputElement, commit: () => void) {
    this.cancelCommit(input);
    // Native blur precedes focus on the next click target. Let that transaction
    // finish before DOM updates can activate Radix's mutation-based focus guard.
    const timer = window.setTimeout(() => {
      this.pendingCommits.delete(input);
      commit();
    }, 0);
    this.pendingCommits.set(input, { timer, commit });
  }
  private sync(previous: VisualTableColumn) {
    const column = this.params.definition;
    const update = (input: HTMLInputElement, next: string, old: string) => {
      const focused = document.activeElement === input;
      // A remote echo or another column's change must not overwrite an active draft.
      if (focused && input.value !== old) return;
      if (input.value === next) return;
      const start = input.selectionStart,
        end = input.selectionEnd,
        direction = input.selectionDirection;
      input.value = next;
      if (focused && start !== null && end !== null)
        input.setSelectionRange(
          Math.min(start, next.length),
          Math.min(end, next.length),
          direction ?? undefined,
        );
    };
    update(this.name, column.name, previous.name);
    this.name.setAttribute("aria-label", `Название столбца ${column.name}`);
    this.name.title = column.name;
    if (this.formula) {
      update(this.formula, column.formula ?? "", previous.formula ?? "");
      this.formula.setAttribute("aria-label", `Формула: ${column.name}`);
    }
    if (this.sort) {
      const label =
        this.params.direction === "asc"
          ? "↑"
          : this.params.direction === "desc"
            ? "↓"
            : "↕";
      if (this.sort.textContent !== label) this.sort.textContent = label;
      this.sort.setAttribute("aria-label", `Сортировка: ${column.name}`);
    }
    if (this.remove) {
      this.remove.hidden = !this.params.remove;
      this.remove.style.display = this.params.remove ? "" : "none";
      this.remove.setAttribute("aria-label", `Удалить столбец ${column.name}`);
    }
    if (this.summary) {
      this.summary.value = column.summary ?? "none";
      this.summary.setAttribute("aria-label", `Итог: ${column.name}`);
    }
    if (this.readonlyFormula) {
      this.readonlyFormula.hidden = !column.formula;
      const formula = column.formula
        ? `ƒ ${column.formula}`
        : "";
      if (this.readonlyFormula.textContent !== formula)
        this.readonlyFormula.textContent = formula;
      this.readonlyFormula.title = column.formula ?? "";
    }
  }
  getGui() {
    return this.element;
  }
  update(options: SqlTableHeaderOptions) {
    return this.refresh({ ...this.params, ...options });
  }
  destroy() {
    // Closing the modal or switching hosts must preserve the last blur edit.
    for (const [input, pending] of this.pendingCommits) {
      this.cancelCommit(input);
      pending.commit();
    }
    this.params.unregister?.(this);
  }
  refresh(params: HeaderParams) {
    const previous = this.params;
    // These changes alter the available controls, not merely their values.
    if (
      params.definition.id !== previous.definition.id ||
      params.editable !== previous.editable ||
      params.definition.type !== previous.definition.type
    )
      return false;
    this.params = params;
    this.sync(previous.definition);
    return true;
  }
}
