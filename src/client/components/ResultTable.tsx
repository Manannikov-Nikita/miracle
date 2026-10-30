import { useEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaretLeft, CaretRight, Copy, Table } from "@phosphor-icons/react";
import type { Cell, ResultSet } from "../../shared/types";
import { getResultRows } from "../api";
import { ErrorBox, IconButton, Spinner } from "./UI";
export function cellText(value: Cell | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
export default function ResultTable({
  result,
  onNotify,
}: {
  result: ResultSet;
  onNotify: (message: string, tone?: "error" | "success" | "info") => void;
}) {
  const [page, setPage] = useState<{
    resultId: string;
    offset: number;
    rows: Cell[][];
  }>();
  const [offset, setOffset] = useState(0);
  // Keep rows during refreshes of this page, never under another page's label.
  const rows =
    page?.resultId === result.id && page.offset === offset ? page.rows : [];
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const parent = useRef<HTMLDivElement>(null);
  const limit = 500;
  useEffect(() => {
    setOffset(0);
    setPage(undefined);
  }, [result.id]);
  useEffect(() => {
    let valid = true;
    setBusy(true);
    setError("");
    getResultRows(result.id, offset, limit)
      .then((r) => {
        if (valid) setPage({ resultId: result.id, offset, rows: r.rows });
      })
      .catch((e) => {
        if (valid) setError(e.message);
      })
      .finally(() => {
        if (valid) setBusy(false);
      });
    return () => {
      valid = false;
    };
  }, [result.id, result.rowCount, result.byteCount, offset, reload]);
  const columns = useMemo<ColumnDef<Cell[]>[]>(
    () =>
      result.columns.map((col, index) => ({
        id: col.id,
        accessorFn: (r) => r[index],
        header: () => (
          <>
            <span>{col.name}</span>
            <small>{col.type}</small>
          </>
        ),
        cell: (c) => (
          <span
            className={
              c.getValue() === null
                ? "null-value"
                : typeof c.getValue() === "number" ||
                    /Int|Decimal|Float|Double|Real|Numeric|bigint|integer|double|decimal/i.test(
                      col.type,
                    )
                  ? "numeric-value"
                  : ""
            }
          >
            {cellText(c.getValue() as Cell)}
          </span>
        ),
        size: Math.min(270, Math.max(140, col.name.length * 9 + 35)),
        minSize: 80,
        maxSize: 800,
      })),
    [result.columns],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
  });
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 30,
    overscan: 10,
  });
  const virtualRows = virtual.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom = virtualRows.length
    ? Math.max(0, virtual.getTotalSize() - virtualRows.at(-1)!.end)
    : 0;
  const columnCount = table.getVisibleLeafColumns().length + 1;
  async function copy() {
    try {
      const text = [
        result.columns.map((c) => c.name).join("\t"),
        ...rows.map((r) =>
          r
            .map((v) => (v === null ? "" : cellText(v).replaceAll("\t", " ")))
            .join("\t"),
        ),
      ].join("\n");
      await navigator.clipboard.writeText(text);
      onNotify("Текущая страница скопирована", "success");
    } catch {
      onNotify("Не удалось скопировать. Выделите данные вручную.", "error");
    }
  }
  return (
    <div className="result-table-shell">
      {error && (
        <div className="result-refresh-error">
          <ErrorBox>{error}</ErrorBox>
          <button
            type="button"
            className="text-button"
            onClick={() => setReload((value) => value + 1)}
          >
            Повторить загрузку
          </button>
        </div>
      )}
      <div className="result-table-scroll" ref={parent} aria-busy={busy}>
        <table
          className="result-table"
          style={{ width: table.getTotalSize() + 48 }}
        >
          <thead>
            <tr>
              <th className="row-number" style={{ width: 48 }}>
                #
              </th>
              {table.getHeaderGroups()[0].headers.map((h) => (
                <th key={h.id} style={{ width: h.getSize() }}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  <div
                    role="separator"
                    aria-label={`Ширина столбца ${h.column.id}`}
                    aria-orientation="vertical"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                        e.preventDefault();
                        table.setColumnSizing((s) => ({
                          ...s,
                          [h.column.id]: Math.max(
                            80,
                            h.getSize() + (e.key === "ArrowRight" ? 16 : -16),
                          ),
                        }));
                      }
                    }}
                    onMouseDown={h.getResizeHandler()}
                    onTouchStart={h.getResizeHandler()}
                    className={`column-resizer ${h.column.getIsResizing() ? "is-resizing" : ""}`}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr aria-hidden="true" className="result-table-spacer">
                <td colSpan={columnCount} style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((v) => {
              const row = table.getRowModel().rows[v.index];
              return (
                <tr
                  key={row.id}
                  className={`result-data-row${v.index % 2 === 0 ? " is-striped" : ""}`}
                >
                  <td className="row-number">{offset + v.index + 1}</td>
                  {row.getVisibleCells().map((c) => (
                    <td
                      key={c.id}
                      style={{ width: c.column.getSize() }}
                      title={cellText(c.getValue() as Cell)}
                    >
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden="true" className="result-table-spacer">
                <td colSpan={columnCount} style={{ height: paddingBottom }} />
              </tr>
            )}
          </tbody>
        </table>
        {!busy && !error && rows.length === 0 && (
          <div className="table-empty">
            <Table size={22} />
            <span>Запрос выполнен. Строк нет.</span>
          </div>
        )}
      </div>
      <div className="table-footer">
        <span>
          {busy ? <Spinner /> : <span className="status-dot" />}
          {result.rowCount.toLocaleString("ru-RU")} строк
          <span className="footer-divider" />
          {result.columns.length} столбцов
        </span>
        <div>
          <IconButton
            label="Скопировать текущую страницу"
            disabled={!rows.length}
            onClick={copy}
          >
            <Copy size={14} />
          </IconButton>
          <span className="page-count">
            {result.rowCount
              ? `${offset + 1}–${Math.min(offset + limit, result.rowCount)}`
              : "0"}
          </span>
          <IconButton
            label="Предыдущая страница"
            disabled={offset === 0 || busy}
            onClick={() => {
              setOffset((o) => Math.max(0, o - limit));
              parent.current?.scrollTo(0, 0);
            }}
          >
            <CaretLeft size={14} />
          </IconButton>
          <IconButton
            label="Следующая страница"
            disabled={offset + limit >= result.rowCount || busy}
            onClick={() => {
              setOffset((o) => o + limit);
              parent.current?.scrollTo(0, 0);
            }}
          >
            <CaretRight size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
