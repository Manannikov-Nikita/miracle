import type { IHeaderParams } from "ag-grid-community";
import type { VisualTableColumn } from "../../shared/visual-table";

export type SqlTableHeaderOptions = {
  definition: VisualTableColumn;
  editable: boolean;
  selected?: boolean;
  direction?: "asc" | "desc";
  openEditor: () => void;
  sort: () => void;
  register?: (header: SqlTableHeader) => void;
  unregister?: (header: SqlTableHeader) => void;
};
type HeaderParams = IHeaderParams & SqlTableHeaderOptions;

/** Update title and selection in place without rebuilding the grid or moving focus. */
export class SqlTableHeader {
  private element = document.createElement("div");
  private params!: HeaderParams;
  private name!: HTMLButtonElement | HTMLSpanElement;
  private sort?: HTMLButtonElement;

  init(params: HeaderParams) {
    this.params = params;
    this.element.className = "sql-table-column-header";
    const title = document.createElement("div");
    title.className = "sql-table-column-title";
    this.name = document.createElement(params.editable ? "button" : "span");
    this.name.className = "sql-table-column-name";
    this.name.dataset.columnName = params.definition.id;
    if (this.name instanceof HTMLButtonElement) {
      this.name.type = "button";
      this.name.addEventListener("click", () => this.params.openEditor());
    }
    title.append(this.name);
    if (params.editable) {
      const sort = (this.sort = document.createElement("button"));
      sort.type = "button";
      sort.className = "sql-table-column-sort";
      sort.title = "Сортировка по столбцу";
      sort.addEventListener("click", () => this.params.sort());
      title.append(sort);
    }
    this.element.append(title);
    this.element.addEventListener("pointerdown", (event) =>
      event.stopPropagation(),
    );
    this.sync();
    params.register?.(this);
  }
  private sync() {
    const column = this.params.definition;
    this.name.textContent = column.name;
    this.name.title = column.name;
    this.element.classList.toggle("is-editing", Boolean(this.params.selected));
    if (this.name instanceof HTMLButtonElement) {
      this.name.setAttribute(
        "aria-label",
        `Редактировать столбец ${column.name}`,
      );
      this.name.setAttribute(
        "aria-expanded",
        String(Boolean(this.params.selected)),
      );
    }
    if (this.sort) {
      this.sort.textContent =
        this.params.direction === "asc"
          ? "↑"
          : this.params.direction === "desc"
            ? "↓"
            : "↕";
      this.sort.setAttribute("aria-label", `Сортировка: ${column.name}`);
    }
  }
  getGui() {
    return this.element;
  }
  update(options: SqlTableHeaderOptions) {
    return this.refresh({ ...this.params, ...options });
  }
  destroy() {
    this.params.unregister?.(this);
  }
  refresh(params: HeaderParams) {
    if (
      params.definition.id !== this.params.definition.id ||
      params.editable !== this.params.editable
    )
      return false;
    this.params = params;
    this.sync();
    return true;
  }
}
