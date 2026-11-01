import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
} from "@phosphor-icons/react";
import type { Cell, ResultSet } from "../../shared/types";
import type {
  TableColor,
  TableSpec,
  TableViewColumn,
} from "../../shared/tableTypes";
import { getResultRows } from "../api";
import { ErrorBox } from "../components/UI";
import { cellText, isNumericColumn } from "./model";
import {
  buildTable,
  createTableSpec,
  formatTableCell,
  tableBarPercent,
} from "./tableModel";
import { acquireTableSnapshot } from "./tableSnapshot";
import "./table-view.css";

const pageSize = 200;
const palette: Record<TableColor, string> = {
  green: "#91cbb3",
  yellow: "#e7bd7e",
  red: "#ef9c9c",
  blue: "#91b5ff",
  purple: "#c5a4eb",
};
const summaryNames = {
  sum: "Σ",
  avg: "Среднее",
  min: "Мин",
  max: "Макс",
  count: "Кол-во",
  none: "",
};

function contentKey(value: unknown) {
  return JSON.stringify(value, (_key, part) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(
          Object.keys(part)
            .sort()
            .map((key) => [key, part[key]]),
        )
      : part,
  );
}

export default function TableView({
  result,
  initialRows,
  spec: savedSpec,
  visibleColumns,
}: {
  result: ResultSet;
  initialRows: Cell[][];
  spec?: TableSpec;
  visibleColumns?: string[];
}) {
  const authoredSpec = useMemo(
    () => savedSpec ?? createTableSpec(result.columns, visibleColumns),
    [savedSpec, result.columns, visibleColumns],
  );
  const sortScope = contentKey([
    result.id,
    authoredSpec.sort?.column,
    authoredSpec.sort?.direction,
    authoredSpec.sourceSchema,
    authoredSpec.pivot,
  ]);
  const [localSort, setLocalSort] = useState<{
    scope: string;
    sort: TableSpec["sort"];
  } | null>(null);
  const spec = useMemo(
    () =>
      localSort?.scope === sortScope
        ? { ...authoredSpec, sort: localSort.sort }
        : authoredSpec,
    [authoredSpec, localSort, sortScope],
  );
  useEffect(() => {
    setLocalSort(null);
  }, [sortScope]);
  // Identical server echoes must not reset the reader's page or scroll.
  const pageKey = contentKey([result.id, spec]);
  const full = Boolean(
    spec.pivot ||
    spec.sort ||
    spec.filters?.length ||
    Object.values(spec.columns ?? {}).some(
      (c) => (c.summary && c.summary !== "none") || c.display === "bar",
    ),
  );
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Cell[][]>(initialRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(false);
  const [loadedFull, setLoadedFull] = useState(false);
  const [loadedOffset, setLoadedOffset] = useState(0);
  const [loadedId, setLoadedId] = useState(result.id);
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "100px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setOffset(0);
    scroll.current?.scrollTo(0, 0);
  }, [pageKey]);
  useEffect(() => {
    let live = true;
    setError(null);
    if (full && !visible) {
      setLoadedFull(false);
      setRows([]);
      return;
    }
    setBusy(true);
    const read = full ? acquireTableSnapshot(result.id) : undefined;
    const pending =
      read?.promise ??
      (offset === 0
        ? Promise.resolve({ rows: initialRows })
        : getResultRows(result.id, offset, pageSize));
    pending
      .then((data) => {
        if (!live) return;
        setRows(data.rows);
        setLoadedFull(full);
        setLoadedOffset(full ? 0 : offset);
        setLoadedId(result.id);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      read?.release();
    };
  }, [
    result.id,
    full,
    full ? 0 : offset,
    initialRows,
    retry,
    full ? visible : true,
  ]);
  const prepared = useMemo(() => {
    if (
      result.id !== loadedId ||
      full !== loadedFull ||
      (!full && offset !== loadedOffset)
    )
      return null;
    try {
      return { data: buildTable(result.columns, rows, spec) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [
    result.columns,
    result.id,
    loadedId,
    rows,
    spec,
    full,
    loadedFull,
    offset,
    loadedOffset,
  ]);
  const data = prepared?.data;
  const total = full ? (data?.rows.length ?? 0) : result.rowCount;
  const safeOffset = Math.min(
    offset,
    Math.max(0, Math.floor((total - 1) / pageSize) * pageSize),
  );
  const pageRows = full
    ? (data?.rows.slice(safeOffset, safeOffset + pageSize) ?? [])
    : (data?.rows ?? []);
  const columns = data?.columns ?? [];
  const rowHeight = spec.density === "comfortable" ? 38 : 28;
  const virtual = useVirtualizer({
    count: pageRows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });
  useEffect(() => {
    virtual.measure();
  }, [spec.wrap, rowHeight, columns.map((c) => c.options.width).join(",")]);
  const items = virtual.getVirtualItems();
  const top = items[0]?.start ?? 0;
  const bottom = items.length
    ? virtual.getTotalSize() - items[items.length - 1].end
    : 0;
  const width = (column: TableViewColumn) => column.options.width ?? 160;
  const frozen = Math.min(spec.frozenColumns ?? 0, columns.length);
  const cellStyle = (
    column: TableViewColumn,
    index: number,
  ): CSSProperties => ({
    width: width(column),
    textAlign:
      column.options.align ?? (isNumericColumn(column) ? "right" : "left"),
    ...(index < frozen
      ? {
          position: "sticky",
          left: columns.slice(0, index).reduce((n, c) => n + width(c), 0),
          zIndex: 2,
        }
      : {}),
  });
  const sort = (column: TableViewColumn) => {
    const previous =
      spec.sort?.column === column.id ? spec.sort.direction : undefined;
    setLocalSort({
      scope: sortScope,
      sort:
        previous === "desc"
          ? undefined
          : {
              column: column.id,
              direction: previous === "asc" ? "desc" : "asc",
            },
    });
  };
  const failure = error || prepared?.error;
  return (
    <div
      className={`board-result table-view${spec.wrap ? " table-view-wrap" : ""}`}
      ref={host}
      style={{ "--table-row-height": `${rowHeight}px` } as CSSProperties}
    >
      {failure ? (
        <ErrorBox
          className="board-error"
          error={failure}
          title={
            error
              ? "Не удалось загрузить таблицу."
              : "Не удалось подготовить таблицу."
          }
          hint={
            error
              ? "Повторите загрузку сохранённого снимка."
              : "Проверьте настройки таблицы в свойствах блока. Если изменились столбцы, сбросьте настройки таблицы."
          }
          actions={
            error ? (
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                Повторить загрузку
              </button>
            ) : undefined
          }
        />
      ) : !data ? (
        <div className="board-loading" role="status">
          {full ? "Загрузка полного снимка…" : "Загрузка страницы…"}
        </div>
      ) : !columns.length ? (
        <div className="board-loading">
          Все столбцы скрыты. Выберите столбцы в свойствах таблицы.
        </div>
      ) : (
        <>
          <div
            className="board-table-scroll nowheel"
            ref={scroll}
            aria-busy={busy}
          >
            <table
              style={{
                width: columns.reduce((n, c) => n + width(c), 0),
                minWidth: 0,
              }}
            >
              <colgroup>
                {columns.map((column) => (
                  <col key={column.id} style={{ width: width(column) }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((column, index) => (
                    <th
                      key={column.id}
                      style={{
                        ...cellStyle(column, index),
                        zIndex: index < frozen ? 4 : 3,
                      }}
                      aria-sort={
                        spec.sort?.column === column.id
                          ? spec.sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        className="table-header-sort"
                        title="Сортировать для просмотра"
                        onClick={() => sort(column)}
                      >
                        <span>{column.options.label || column.name}</span>
                        {spec.sort?.column === column.id &&
                          (spec.sort.direction === "asc" ? (
                            <CaretUp size={12} />
                          ) : (
                            <CaretDown size={12} />
                          ))}
                      </button>
                      <small title={column.type}>{column.type}</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {top > 0 && (
                  <tr aria-hidden="true" className="table-view-spacer">
                    <td colSpan={columns.length} style={{ height: top }} />
                  </tr>
                )}
                {items.map((item) => (
                  <tr
                    key={item.key}
                    data-index={item.index}
                    ref={virtual.measureElement}
                    className="table-view-row"
                  >
                    {columns.map((column, index) => {
                      const value = pageRows[item.index][index];
                      const display = formatTableCell(
                        value,
                        column,
                        column.options,
                      );
                      const color = display.color
                        ? palette[display.color]
                        : undefined;
                      const mode = column.options.display;
                      const range = data.ranges[column.id];
                      return (
                        <td
                          key={column.id}
                          style={{
                            ...cellStyle(column, index),
                            ...(mode === "color-text" && color
                              ? { color }
                              : {}),
                            ...(mode === "color-background" && color
                              ? {
                                  backgroundColor: `color-mix(in srgb, ${color} 20%, #202329)`,
                                }
                              : {}),
                          }}
                          className={`${value === null ? "board-null " : ""}${index < frozen ? "table-cell-frozen" : ""}`}
                          title={cellText(value)}
                        >
                          {mode === "bar" && range && value !== null && (
                            <span
                              aria-hidden="true"
                              className="table-cell-bar"
                              style={{
                                width: `${tableBarPercent(value, range)}%`,
                                backgroundColor: color ?? palette.blue,
                              }}
                            />
                          )}
                          <span className="table-cell-text">
                            {display.text}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {bottom > 0 && (
                  <tr aria-hidden="true" className="table-view-spacer">
                    <td colSpan={columns.length} style={{ height: bottom }} />
                  </tr>
                )}
              </tbody>
              {Object.keys(data.summaries).length > 0 && (
                <tfoot>
                  <tr>
                    {columns.map((column, index) => (
                      <td key={column.id} style={cellStyle(column, index)}>
                        {Object.hasOwn(data.summaries, column.id) && (
                          <>
                            <small>
                              {summaryNames[column.options.summary ?? "none"]}
                            </small>
                            <span title={cellText(data.summaries[column.id])}>
                              {
                                formatTableCell(
                                  data.summaries[column.id],
                                  column,
                                  {
                                    ...column.options,
                                    mappings: [],
                                    format:
                                      column.options.summary === "count"
                                        ? "number"
                                        : column.options.format,
                                    ...(column.options.summary === "count"
                                      ? { decimals: 0, prefix: "", suffix: "" }
                                      : {}),
                                  },
                                ).text
                              }
                            </span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
            {!pageRows.length && (
              <p className="board-loading">
                {spec.filters?.length
                  ? "Нет строк, подходящих под фильтры."
                  : "В результате нет строк."}
              </p>
            )}
          </div>
          <div className="board-table-footer">
            <span
              title={
                full
                  ? `Исходный снимок: ${result.rowCount} строк; после фильтров: ${data.filteredRowCount}. Итоги по всему представлению.`
                  : "Сохранённый снимок запроса"
              }
            >
              {total ? safeOffset + 1 : 0}–
              {Math.min(safeOffset + pageRows.length, total)} из{" "}
              {total.toLocaleString("ru-RU")}
              {spec.pivot ? " · pivot" : ""}
              {spec.filters?.length
                ? ` · от ${result.rowCount.toLocaleString("ru-RU")}`
                : ""}
              {busy ? " · загрузка" : ""}
            </span>
            {(total > pageSize || safeOffset > 0) && (
              <>
                <button
                  disabled={safeOffset === 0 || busy}
                  aria-label="Предыдущая страница"
                  title="Предыдущая страница"
                  onClick={() => {
                    setOffset(Math.max(0, safeOffset - pageSize));
                    scroll.current?.scrollTo(0, 0);
                  }}
                >
                  <CaretLeft size={16} aria-hidden="true" />
                </button>
                <button
                  disabled={safeOffset + pageSize >= total || busy}
                  aria-label="Следующая страница"
                  title="Следующая страница"
                  onClick={() => {
                    setOffset(safeOffset + pageSize);
                    scroll.current?.scrollTo(0, 0);
                  }}
                >
                  <CaretRight size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
