import { useLayoutEffect, useRef } from "react";
import type { BoardNode, ResultSet } from "../../shared/types";
import { ArrowsClockwise, Code, X } from "@phosphor-icons/react";
import { ChartSettings } from "./ResultView";
import { defaultChart } from "./model";
import TableSettings from "./TableSettings";
import { createTableSpec } from "./tableModel";
import CustomChartDetails from "./CustomChartDetails";
import MarkdownEditor from "./MarkdownEditor";
import ShapeSettings from "./ShapeSettings";
import TextBlockSettings from "./TextBlockSettings";
export default function Inspector({
  boardId,
  node,
  result,
  editable,
  change,
  close,
  openSource,
  presentation = false,
  autoFocus = true,
  refresh,
  refreshing = false,
}: {
  boardId?: string;
  node: BoardNode;
  result?: ResultSet;
  editable: boolean;
  change: (node: BoardNode) => void;
  close: () => void;
  openSource: () => void;
  presentation?: boolean;
  autoFocus?: boolean;
  refresh?: () => void;
  refreshing?: boolean;
}) {
  const firstField = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = panel.current;
    if (autoFocus)
      (firstField.current ?? element)?.focus({ preventScroll: true });
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
      tabIndex={-1}
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
        {node.data.kind !== "shape" && (
          <label>
            Название
            <input
              ref={firstField}
              maxLength={500}
              value={node.data.title}
              readOnly={!editable}
              onChange={(e) =>
                change({
                  ...node,
                  data: { ...node.data, title: e.target.value },
                })
              }
            />
          </label>
        )}
        {node.data.kind === "shape" && (
          <ShapeSettings
            key={node.id}
            shape={node.data.shape ?? { type: "rectangle" }}
            text={node.data.text ?? ""}
            disabled={!editable}
            onChange={(patch) => {
              if (editable)
                change({ ...node, data: { ...node.data, ...patch } });
            }}
          />
        )}
        {node.data.kind === "image" && node.data.image && (
          <>
            <label>
              Описание изображения
              <textarea
                aria-label="Описание изображения"
                maxLength={2000}
                value={node.data.image.alt ?? ""}
                readOnly={!editable}
                onChange={(event) =>
                  change({
                    ...node,
                    data: {
                      ...node.data,
                      image: { ...node.data.image!, alt: event.target.value },
                    },
                  })
                }
              />
            </label>
            <label>
              Размещение
              <select
                aria-label="Размещение изображения"
                disabled={!editable}
                value={node.data.image.fit ?? "contain"}
                onChange={(event) =>
                  change({
                    ...node,
                    data: {
                      ...node.data,
                      image: {
                        ...node.data.image!,
                        fit: event.target.value as "contain" | "cover",
                      },
                    },
                  })
                }
              >
                <option value="contain">Вписать целиком</option>
                <option value="cover">Заполнить блок</option>
              </select>
            </label>
          </>
        )}
        {node.data.kind === "text" && (
          <TextBlockSettings
            key={node.id}
            textStyle={node.data.textStyle}
            text={node.data.text ?? ""}
            disabled={!editable}
            onChange={(patch) => {
              if (editable)
                change({ ...node, data: { ...node.data, ...patch } });
            }}
          />
        )}
        {presentation && node.data.kind === "note" && (
          <label>
            Текст заметки
            <textarea
              className="board-inspector-content-editor"
              aria-label="Текст заметки"
              maxLength={200000}
              value={node.data.text ?? ""}
              readOnly={!editable}
              onChange={(event) =>
                change({
                  ...node,
                  data: { ...node.data, text: event.target.value },
                })
              }
            />
          </label>
        )}
        {presentation && node.data.kind === "markdown" && (
          <div className="board-inspector-content-editor">
            <MarkdownEditor
              key={node.id}
              ariaLabel="Текст Markdown"
              value={node.data.text ?? ""}
              readOnly={!editable}
              onChange={(text) =>
                change({ ...node, data: { ...node.data, text } })
              }
            />
          </div>
        )}
        {node.data.kind === "result" && (
          <>
            {presentation && node.data.source && refresh && (
              <button
                className="board-open-source"
                aria-label="Обновить снимок"
                disabled={!editable || refreshing}
                onClick={refresh}
              >
                <ArrowsClockwise size={16} aria-hidden="true" />
                {refreshing ? "Обновление…" : "Обновить снимок"}
              </button>
            )}
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
                onTableChange={(table) => {
                  if (editable)
                    change({ ...node, data: { ...node.data, table } });
                }}
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
