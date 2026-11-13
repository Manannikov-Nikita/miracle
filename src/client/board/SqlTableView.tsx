import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  AllCommunityModule,
  createGrid,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
} from "ag-grid-community";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowsOut,
  CaretLeft,
  CaretRight,
  Code,
  Funnel,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { ResultSet } from "../../shared/types";
import {
  createResultVisualTable,
  renameVisualTableColumn,
  setVisualTableCell,
  visualTableSourceSchema,
  visualTableSpecSchema,
  type VisualTableColumn,
  type VisualTableRow,
  type VisualTableSpec,
} from "../../shared/visual-table";
import { Modal } from "../components/UI";
import { SqlTableHeader, type SqlTableHeaderOptions } from "./SqlTableHeader";
import { parseSqlTableCell, formatSqlTableCell } from "./sql-table-model";
import { useVisualTableEvaluation } from "./useVisualTableEvaluation";
import "./sql-table.css";

ModuleRegistry.registerModules([AllCommunityModule]);
type Props = {
  spec: VisualTableSpec;
  result?: ResultSet;
  editable?: boolean;
  presentationBackground?: string;
  onChange?: (spec: VisualTableSpec) => void;
  onExit?: () => void;
};
type HistoryEntry = { before: VisualTableSpec; after: VisualTableSpec };
const equals = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const filterOps = {
  contains: "содержит",
  eq: "равно",
  neq: "не равно",
  gt: "больше",
  gte: "не меньше",
  lt: "меньше",
  lte: "не больше",
  isNull: "пусто",
  notNull: "не пусто",
};


export default function SqlTableView(props: Props) {
  const { spec, result, presentationBackground, onExit } = props;
  const editable = Boolean(props.editable && props.onChange);
  const [expanded, setExpanded] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [offset, setOffset] = useState(0);
  const [localError, setLocalError] = useState<string>();
  const [newType, setNewType] = useState<VisualTableColumn["type"]>("number");
  const [filterColumn, setFilterColumn] = useState(spec.columns[0]?.id ?? "");
  const [filterOp, setFilterOp] = useState<keyof typeof filterOps>("contains");
  const [filterValue, setFilterValue] = useState("");
  const [selectedRow, setSelectedRow] = useState<string>();
  const [, historyTick] = useState(0);
  const history = useRef<HistoryEntry[]>([]),
    future = useRef<HistoryEntry[]>([]);
  const [mountedHost, setMountedHost] = useState<HTMLDivElement | null>(null);
  const gridHost = useRef<HTMLDivElement>(null),
    grid = useRef<GridApi<VisualTableRow> | undefined>(undefined);
  const headers = useRef(new Map<string, SqlTableHeader>());
  const installedColumns = useRef("");
  const bindGridHost = useCallback((element: HTMLDivElement | null) => {
    gridHost.current = element;
    setMountedHost(element);
  }, []);
  const trigger = useRef<HTMLButtonElement>(null),
    focusColumn = useRef<string | undefined>(undefined);
  const latest = useRef({ ...props, editable });
  latest.current = { ...props, editable };
  const evaluation = useVisualTableEvaluation(spec, offset);
  const mismatch = Boolean(
    result && spec.sourceResultSetId && result.id !== spec.sourceResultSetId,
  );
  const sameSchema = Boolean(
    result && spec.sourceSchema === visualTableSourceSchema(result.columns),
  );
  const pageKey = JSON.stringify([
    spec.sourceResultSetId,
    spec.filters,
    spec.sort,
  ]);
  useEffect(() => setOffset(0), [pageKey]);
  useEffect(() => {
    if (!spec.columns.some((c) => c.id === filterColumn))
      setFilterColumn(spec.columns[0]?.id ?? "");
  }, [spec.columns, filterColumn]);
  useEffect(() => {
    if (
      evaluation.data &&
      offset > 0 &&
      offset >= evaluation.data.totalRowCount
    )
      setOffset(
        Math.max(
          0,
          Math.floor((evaluation.data.totalRowCount - 1) / 500) * 500,
        ),
      );
  }, [evaluation.data, offset]);

  const change = useCallback(
    (transform: (current: VisualTableSpec) => VisualTableSpec) => {
      const current = latest.current;
      if (!current.editable || !current.onChange) return;
      try {
        const next = visualTableSpecSchema.parse(transform(current.spec));
        if (equals(next, current.spec)) return;
        history.current.push({ before: current.spec, after: next });
        history.current = history.current.slice(-20);
        future.current = [];
        setLocalError(undefined);
        current.onChange(next);
        historyTick((value) => value + 1);
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );
  const travel = useCallback((back: boolean) => {
    const current = latest.current;
    if (!current.editable || !current.onChange) return;
    const from = back ? history : future,
      to = back ? future : history;
    const entry = from.current.at(-1);
    if (!entry) return;
    if (!equals(current.spec, back ? entry.after : entry.before)) {
      from.current = [];
      historyTick((v) => v + 1);
      return;
    }
    from.current.pop();
    to.current.push(entry);
    setLocalError(undefined);
    current.onChange(back ? entry.before : entry.after);
    historyTick((v) => v + 1);
  }, []);
  const editCell = useCallback(
    (rowId: string, columnId: string, raw: unknown) => {
      const column = latest.current.spec.columns.find((c) => c.id === columnId);
      if (!column) return;
      try {
        const value = parseSqlTableCell(raw, column.type);
        change((current) =>
          setVisualTableCell(current, rowId, columnId, value),
        );
      } catch (error) {
        setLocalError(
          `${column.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [change],
  );
  const definitions = useCallback(
    () =>
      latest.current.spec.columns.map((column): ColDef<VisualTableRow> => ({
        colId: column.id,
        headerName: column.name,
        headerComponent: SqlTableHeader,
        headerComponentParams: {
          register: (header: SqlTableHeader) => headers.current.set(column.id, header),
          unregister: (header: SqlTableHeader) => {
            if (headers.current.get(column.id) === header)
              headers.current.delete(column.id);
          },
          definition: column,
          editable: latest.current.editable,
          direction:
            latest.current.spec.sort?.columnId === column.id
              ? latest.current.spec.sort.direction
              : undefined,
          rename: (name: string) =>
            change((current) =>
              renameVisualTableColumn(current, column.id, name),
            ),
          formula: (formula: string) =>
            change((current) => ({
              ...current,
              columns: current.columns.map((c) =>
                c.id === column.id
                  ? { ...c, formula: formula || undefined }
                  : c,
              ),
            })),
          summary: (summary: VisualTableColumn["summary"]) =>
            change((current) => ({
              ...current,
              columns: current.columns.map((c) =>
                c.id === column.id ? { ...c, summary } : c,
              ),
            })),
          sort: () =>
            change((current) => ({
              ...current,
              sort:
                current.sort?.columnId !== column.id
                  ? { columnId: column.id, direction: "asc" }
                  : current.sort.direction === "asc"
                    ? { columnId: column.id, direction: "desc" }
                    : undefined,
            })),
          remove:
            !column.sourceColumnId && latest.current.spec.columns.length > 1
              ? () =>
                  change((current) => ({
                    ...current,
                    columns: current.columns.filter((c) => c.id !== column.id),
                    rows: current.rows?.map((row) => ({
                      ...row,
                      values: Object.fromEntries(
                        Object.entries(row.values).filter(
                          ([id]) => id !== column.id,
                        ),
                      ),
                    })),
                    edits: current.edits.filter(
                      (edit) => edit.columnId !== column.id,
                    ),
                    filters: current.filters?.filter(
                      (filter) => filter.columnId !== column.id,
                    ),
                    sort:
                      current.sort?.columnId === column.id
                        ? undefined
                        : current.sort,
                  }))
              : undefined,
        },
        width: column.width ?? (column.formula ? 210 : 160),
        minWidth: 130,
        valueGetter: (params) => params.data?.values[column.id],
        valueFormatter: (params) =>
          formatSqlTableCell(params.value, column.type),
        cellDataType: false,
        cellEditor:
          column.type === "boolean" ? "agSelectCellEditor" : "agTextCellEditor",
        ...(column.type === "boolean"
          ? { cellEditorParams: { values: [null, true, false] } }
          : {}),
        cellClass: (params) =>
          [
            column.type === "number" ? "sql-table-numeric" : "",
            params.data &&
            !params.node.rowPinned &&
            latest.current.spec.edits.some(
              (edit) =>
                edit.rowId === params.data!.id && edit.columnId === column.id,
            )
              ? "sql-table-overridden"
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        tooltipValueGetter: (params) =>
          params.data &&
          latest.current.spec.edits.some(
            (edit) =>
              edit.rowId === params.data!.id && edit.columnId === column.id,
          )
            ? "Локальная правка. Исходные данные не изменены."
            : undefined,
      })),
    [change],
  );
  const columnKey = JSON.stringify([spec.columns, spec.sort, editable]);
  const structureKey = JSON.stringify([
    spec.columns.map((column) => [column.id, column.type]),
    editable,
  ]);
  useLayoutEffect(() => {
    if (!mountedHost) return;
    const api = createGrid<VisualTableRow>(mountedHost, {
      theme: themeQuartz.withParams({
        backgroundColor: "var(--sql-table-bg)",
        foregroundColor: "var(--sql-table-text)",
        headerBackgroundColor: "var(--sql-table-raised)",
        borderColor: "var(--sql-table-border)",
        accentColor: "var(--sql-table-accent)",
        chromeBackgroundColor: "var(--sql-table-raised)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: 12,
        spacing: 4,
        wrapperBorderRadius: 0,
      }),
      columnDefs: definitions(),
      rowData: [],
      getRowId: (p) => p.data.id,
      defaultColDef: {
        editable: (p) => latest.current.editable && !p.node.rowPinned,
        resizable: true,
        sortable: false,
        suppressMovable: true,
        suppressHeaderMenuButton: true,
      },
      headerHeight: latest.current.editable ? 104 : 48,
      rowHeight: 30,
      readOnlyEdit: true,
      stopEditingWhenCellsLoseFocus: true,
      enableCellTextSelection: true,
      animateRows: false,
      tooltipShowDelay: 300,
      localeText: { noRowsToShow: "Нет строк", loadingOoo: "Загрузка…" },
      onCellEditRequest: (event) => {
        if (event.data && !event.node.rowPinned)
          editCell(event.data.id, event.column.getColId(), event.newValue);
      },
      onCellFocused: (event) =>
        setSelectedRow(
          event.rowIndex == null || event.rowPinned
            ? undefined
            : grid.current?.getDisplayedRowAtIndex(event.rowIndex)?.data?.id,
        ),
      onColumnResized: (event) => {
        if (
          event.finished &&
          event.source === "uiColumnResized" &&
          event.column
        )
          change((current) => ({
            ...current,
            columns: current.columns.map((c) =>
              c.id === event.column!.getColId()
                ? { ...c, width: event.column!.getActualWidth() }
                : c,
            ),
          }));
      },
    });
    grid.current = api;
    installedColumns.current = JSON.stringify([
      latest.current.spec.columns.map((column) => [column.id, column.type]),
      latest.current.editable,
    ]);
    return () => {
      grid.current = undefined;
      api.destroy();
    };
  }, [mountedHost, presentationBackground, definitions, editCell, change]);
  useEffect(() => {
    const api = grid.current;
    if (!api) return;
    const nextDefinitions = definitions();
    if (installedColumns.current !== structureKey) {
      api.setGridOption("columnDefs", nextDefinitions);
      api.setGridOption("headerHeight", editable ? 104 : 48);
      installedColumns.current = structureKey;
    } else {
      // Replacing columnDefs (or refreshHeader) re-enters AG Grid's focus restoration.
      // Update live inputs in place; keep virtualized headers' future params current too.
      for (const definition of nextDefinitions) {
        const id = definition.colId!;
        const column = api.getColumn(id);
        if (!column) continue;
        const current = column.getColDef();
        current.headerName = definition.headerName;
        current.headerComponentParams = definition.headerComponentParams;
        headers.current.get(id)?.update(
          definition.headerComponentParams as SqlTableHeaderOptions,
        );
        const width = latest.current.spec.columns.find((item) => item.id === id)?.width;
        if (width !== undefined && width !== column.getActualWidth())
          api.setColumnWidths([{ key: id, newWidth: width }]);
      }
    }
    if (focusColumn.current) {
      const id = focusColumn.current;
      focusColumn.current = undefined;
      grid.current?.ensureColumnVisible(id);
      queueMicrotask(() =>
        gridHost.current
          ?.querySelector<HTMLInputElement>(`[data-column-name="${id}"]`)
          ?.focus(),
      );
    }
  }, [columnKey, structureKey, mountedHost, definitions, editable]);
  useEffect(() => {
    const data = evaluation.data;
    grid.current?.setGridOption("rowData", data?.rows ?? []);
    if (data) {
      const values = { ...data.summaries };
      const label = spec.columns.find(
        (c) => c.summary === undefined || c.summary === "none",
      );
      if (label) values[label.id] = "Итого";
      grid.current?.setGridOption(
        "pinnedBottomRowData",
        Object.keys(data.summaries).length
          ? [{ id: "__visual_totals__", values }]
          : [],
      );
    } else grid.current?.setGridOption("pinnedBottomRowData", []);
    grid.current?.refreshCells({ force: true });
  }, [evaluation.data, mountedHost]);

  const addColumn = () =>
    change((current) => {
      const id = crypto.randomUUID();
      focusColumn.current = id;
      let n = current.columns.length + 1;
      while (current.columns.some((c) => c.name === `Столбец ${n}`)) n++;
      return {
        ...current,
        columns: [
          ...current.columns,
          { id, name: `Столбец ${n}`, type: newType },
        ],
      };
    });
  const addRow = () =>
    change((current) => ({
      ...current,
      rows: [...(current.rows ?? []), { id: crypto.randomUUID(), values: {} }],
    }));
  const removeRow = () => {
    if (selectedRow)
      change((current) => ({
        ...current,
        rows: current.rows?.filter((row) => row.id !== selectedRow),
        edits: current.edits.filter((edit) => edit.rowId !== selectedRow),
      }));
  };
  const adopt = () => {
    if (!result) return;
    change((current) => {
      const fresh = createResultVisualTable(result);
      return sameSchema
        ? {
            ...current,
            sourceResultSetId: result.id,
            sourceSchema: fresh.sourceSchema,
            edits: [],
          }
        : fresh;
    });
    setAdopting(false);
  };
  const keydown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (
      !editable ||
      event.defaultPrevented ||
      (event.target as HTMLElement).closest(
        "input,textarea,select,[contenteditable=true]",
      )
    )
      return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      travel(!event.shiftKey);
    }
    if (event.ctrlKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      travel(false);
    }
  };
  const clipboard = (event: ClipboardEvent, paste = false) => {
    event.stopPropagation();
    if (
      (event.target as HTMLElement).closest(
        "input,textarea,[contenteditable=true]",
      )
    )
      return;
    const focused = grid.current?.getFocusedCell();
    if (!focused || focused.rowPinned) return;
    const row = grid.current?.getDisplayedRowAtIndex(focused.rowIndex)?.data;
    if (!row) return;
    const id = focused.column.getColId();
    if (paste) {
      if (editable) {
        event.preventDefault();
        editCell(row.id, id, event.clipboardData.getData("text/plain"));
      }
    } else if (!window.getSelection()?.toString()) {
      event.preventDefault();
      event.clipboardData.setData("text/plain", String(row.values[id] ?? ""));
    }
  };
  const canUndo =
    editable &&
    Boolean(history.current.length) &&
    equals(spec, history.current.at(-1)?.after);
  const canRedo =
    editable &&
    Boolean(future.current.length) &&
    equals(spec, future.current.at(-1)?.before);
  const error = localError ?? evaluation.error;
  const presentationStyle = presentationBackground
    ? ({
        "--sql-table-bg": presentationBackground,
        "--sql-table-text": "var(--board-text)",
        "--sql-table-raised": "var(--board-raised)",
        "--sql-table-border": "var(--board-border)",
      } as CSSProperties)
    : undefined;
  const body = (
    <div
      className={`board-sql-table nodrag nopan nowheel nokey${expanded ? " sql-table-expanded" : ""}`}
      style={presentationStyle}
      onKeyDown={keydown}
      onCopy={(event) => clipboard(event)}
      onPaste={(event) => clipboard(event, true)}
    >
      {!presentationBackground && (
        <div
          className="sql-table-toolbar"
          role="toolbar"
          aria-label="Действия таблицы"
        >
          {editable && (
            <>
              <button
                onClick={() => travel(true)}
                disabled={!canUndo}
                title="Отменить изменение таблицы"
                aria-label="Отменить изменение таблицы"
              >
                <ArrowCounterClockwise size={15} />
              </button>
              <button
                onClick={() => travel(false)}
                disabled={!canRedo}
                title="Повторить изменение таблицы"
                aria-label="Повторить изменение таблицы"
              >
                <ArrowClockwise size={15} />
              </button>
              <span className="sql-table-divider" />
              <select
                aria-label="Тип нового столбца"
                value={newType}
                onChange={(event) =>
                  setNewType(event.target.value as VisualTableColumn["type"])
                }
              >
                <option value="number">Число</option>
                <option value="text">Текст</option>
                <option value="boolean">Да / нет</option>
              </select>
              <button
                onClick={addColumn}
                disabled={spec.columns.length >= 100}
                title="Добавить столбец"
              >
                <Plus size={14} />
                Столбец
              </button>
              {!spec.sourceResultSetId && (
                <>
                  <button
                    onClick={addRow}
                    disabled={(spec.rows?.length ?? 0) >= 1000}
                    title="Добавить строку"
                  >
                    <Plus size={14} />
                    Строка
                  </button>
                  <button
                    onClick={removeRow}
                    disabled={!selectedRow}
                    aria-label="Удалить выбранную строку"
                    title="Удалить выбранную строку"
                  >
                    <Trash size={14} />
                  </button>
                </>
              )}
            </>
          )}
          {editable && (
            <button
              onClick={() => setShowFilters((v) => !v)}
              aria-label="Фильтры таблицы"
              aria-expanded={showFilters}
              aria-pressed={Boolean(spec.filters?.length)}
              title="Фильтры"
            >
              <Funnel size={15} />
              {Boolean(spec.filters?.length) && spec.filters!.length}
            </button>
          )}
          <button
            onClick={() => setShowSql((v) => !v)}
            aria-label="Показать SQL таблицы"
            aria-expanded={showSql}
            title="Показать SQL"
          >
            <Code size={16} />
          </button>
          {!expanded && (
            <button
              ref={trigger}
              onClick={() => {
                grid.current?.stopEditing();
                setExpanded(true);
              }}
              aria-label="Развернуть таблицу"
              title="Развернуть таблицу"
            >
              <ArrowsOut size={15} />
            </button>
          )}
          {onExit && (
            <button
              className="sql-table-exit"
              onClick={onExit}
              title="Вернуться к настройкам обычной таблицы"
            >
              Обычный вид
            </button>
          )}
        </div>
      )}
      {mismatch && (
        <div className="sql-table-source-warning" role="status">
          <span>
            Источник обновлён. Здесь сохранены данные и правки предыдущего
            снимка.
          </span>
          {editable && (
            <button onClick={() => setAdopting(true)}>
              Использовать новый снимок
            </button>
          )}
        </div>
      )}
      {showFilters && editable && (
        <div className="sql-table-filters">
          <div className="sql-table-filter-list">
            {spec.filters?.map((filter, index) => (
              <span key={index}>
                {spec.columns.find((c) => c.id === filter.columnId)?.name}{" "}
                {filterOps[filter.op]} {filter.value}
                <button
                  aria-label={`Удалить фильтр ${index + 1}`}
                  onClick={() =>
                    change((current) => ({
                      ...current,
                      filters: current.filters?.filter((_, i) => i !== index),
                    }))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              change((current) => ({
                ...current,
                filters: [
                  ...(current.filters ?? []),
                  {
                    columnId: filterColumn,
                    op: filterOp,
                    ...(!["isNull", "notNull"].includes(filterOp) && {
                      value: filterValue,
                    }),
                  },
                ],
              }));
            }}
          >
            <select
              aria-label="Столбец фильтра"
              value={filterColumn}
              onChange={(event) => setFilterColumn(event.target.value)}
            >
              {spec.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Условие фильтра"
              value={filterOp}
              onChange={(event) =>
                setFilterOp(event.target.value as keyof typeof filterOps)
              }
            >
              {Object.entries(filterOps).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {!["isNull", "notNull"].includes(filterOp) && (
              <input
                aria-label="Значение фильтра"
                value={filterValue}
                onChange={(event) => setFilterValue(event.target.value)}
                placeholder="Значение"
              />
            )}
            <button type="submit" disabled={(spec.filters?.length ?? 0) >= 20}>
              Добавить
            </button>
          </form>
        </div>
      )}
      {error && (
        <div className="sql-table-error" role="alert">
          <span>{error}</span>
          {evaluation.data && (
            <small>Показан последний успешный результат.</small>
          )}
          <button
            onClick={() => {
              setLocalError(undefined);
              evaluation.retry();
            }}
          >
            Повторить
          </button>
        </div>
      )}
      <div
        className="sql-table-grid"
        ref={bindGridHost}
        aria-label="Редактируемая таблица"
        aria-busy={evaluation.busy}
      />
      {!presentationBackground && (
        <div className="sql-table-footer">
          <span role="status">
            {evaluation.busy
              ? "Пересчёт…"
              : evaluation.data
                ? `${spec.filters?.length ? "После фильтров" : "Строк"}: ${evaluation.data.totalRowCount.toLocaleString("ru-RU")}`
                : "Загрузка…"}
          </span>
          {Boolean(spec.edits.length) && (
            <span title="Правки сохранены в проекте, исходный результат SQL не изменён">
              Правок: {spec.edits.length}
            </span>
          )}
          {evaluation.data && evaluation.data.totalRowCount > 500 && (
            <div className="sql-table-pages">
              <button
                aria-label="Предыдущие строки"
                disabled={offset === 0 || evaluation.busy}
                onClick={() => setOffset(Math.max(0, offset - 500))}
              >
                <CaretLeft size={14} />
              </button>
              <span>
                {offset + 1}–
                {Math.min(offset + 500, evaluation.data.totalRowCount)}
              </span>
              <button
                aria-label="Следующие строки"
                disabled={
                  offset + 500 >= evaluation.data.totalRowCount ||
                  evaluation.busy
                }
                onClick={() => setOffset(offset + 500)}
              >
                <CaretRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      {showSql && (
        <div className="sql-table-query">
          <div>
            SQL представления
            {evaluation.stale && " · последний успешный запрос"}
          </div>
          <pre>
            {evaluation.data?.sql ?? "Запрос появится после успешного расчёта."}
          </pre>
          {Boolean(evaluation.data?.parameters.length) && (
            <details>
              <summary>Параметры</summary>
              <pre>{JSON.stringify(evaluation.data?.parameters, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
  return (
    <>
      {expanded ? (
        <div className="sql-table-opened" aria-hidden="true">
          Таблица открыта в расширенном редакторе.
        </div>
      ) : (
        body
      )}
      <Modal
        open={expanded}
        onOpenChange={setExpanded}
        title="Редактор таблицы"
        className="sql-table-modal"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        {expanded ? body : null}
      </Modal>
      <Modal
        open={adopting}
        onOpenChange={setAdopting}
        title="Использовать новый снимок?"
      >
        <p>
          Локальные правки ячеек будут сброшены.{" "}
          {sameSchema
            ? "Формулы, фильтры и настройки столбцов сохранятся."
            : "Состав столбцов изменился: формулы и настройки таблицы будут созданы заново."}
        </p>
        <div className="sql-table-confirm">
          <button onClick={() => setAdopting(false)}>Отмена</button>
          <button className="primary" onClick={adopt}>
            Использовать новый снимок
          </button>
        </div>
      </Modal>
    </>
  );
}
