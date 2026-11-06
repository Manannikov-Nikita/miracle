import { useLayoutEffect, useRef } from "react";
import type { BoardNode, ResultSet } from "../../shared/types";
import { Code, X } from "@phosphor-icons/react";
import { ChartSettings } from "./ResultView";
import { defaultChart } from "./model";
import TableSettings from "./TableSettings";
import { createTableSpec } from "./tableModel";
import CustomChartDetails from "./CustomChartDetails";
export default function Inspector({
  boardId,
  node,
  result,
  editable,
  change,
  close,
  openSource,
}: {
  boardId?: string;
  node: BoardNode;
  result?: ResultSet;
  editable: boolean;
  change: (node: BoardNode) => void;
  close: () => void;
  openSource: () => void;
}) {
  const firstField = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = panel.current;
    firstField.current?.focus({ preventScroll: true });
    return () => {
      if (element?.contains(document.activeElement) && trigger?.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <aside
      ref={panel}
      className="board-inspector nodrag nopan nowheel"
      aria-label="Свойства блока"
    >
      <header>
        <strong>Свойства блока</strong>
        <button
          aria-label="Закрыть свойства"
          title="Закрыть свойства"
          onClick={close}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="board-inspector-body">
        <label>
          Название
          <input
            ref={firstField}
            maxLength={500}
            value={node.data.title}
            readOnly={!editable}
            onChange={(e) =>
              change({ ...node, data: { ...node.data, title: e.target.value } })
            }
          />
        </label>
        {node.data.kind === "result" && (
          <>
            <div className="board-view-tabs">
              <button
                disabled={!editable}
                aria-pressed={!node.data.view || node.data.view === "table"}
                onClick={() => {
                  if (node.data.view && node.data.view !== "table")
                    change({ ...node, data: { ...node.data, view: "table" } });
                }}
              >
                Таблица
              </button>
              <button
                disabled={!editable || !result}
                aria-pressed={node.data.view === "chart"}
                onClick={() => {
                  if (node.data.view === "chart") return;
                  change({
                    ...node,
                    data: {
                      ...node.data,
                      view: "chart",
                      chart: node.data.chart ?? defaultChart(result!.columns),
                    },
                  });
                }}
              >
                График
              </button>
              {node.data.customChart && (
                <button
                  disabled={!editable}
                  aria-pressed={node.data.view === "custom"}
                  onClick={() => {
                    if (node.data.view !== "custom")
                      change({
                        ...node,
                        data: { ...node.data, view: "custom" },
                      });
                  }}
                >
                  Кастомный график
                </button>
              )}
            </div>
            {node.data.view === "custom" && node.data.customChart && (
              <CustomChartDetails boardId={boardId} node={node} />
            )}
            {node.data.view === "chart" && result && (
              <ChartSettings
                result={result}
                table={node.data.table}
                visibleColumns={node.data.visibleColumns}
                spec={node.data.chart ?? defaultChart(result.columns)}
                disabled={!editable}
                onChange={(chart) => {
                  if (editable)
                    change({ ...node, data: { ...node.data, chart } });
                }}
              />
            )}
            {(!node.data.view || node.data.view === "table") && result && (
              <TableSettings
                key={node.id}
                result={result}
                spec={
                  node.data.table ??
                  createTableSpec(result.columns, node.data.visibleColumns)
                }
                disabled={!editable}
                onChange={(table) => {
                  if (editable)
                    change({ ...node, data: { ...node.data, table } });
                }}
              />
            )}
            <details key={`source:${node.id}`} className="board-source-details">
              <summary>Источник</summary>
              <div className="board-source-content">
                {node.data.source && (
                  <button
                    className="board-open-source"
                    onClick={openSource}
                    title="Открыть SQL в редакторе"
                  >
                    <Code size={16} aria-hidden="true" /> Открыть SQL
                  </button>
                )}
                <p className="board-source-note">
                  Закреплённый SQL · версия {node.data.sourceRevision ?? 1}
                  <br />
                  Снимок {node.data.resultSetId?.slice(0, 8)}
                </p>
              </div>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
