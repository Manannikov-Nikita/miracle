import type { BoardNode, ResultSet } from "../../shared/types";
import { ChartSettings } from "./ResultView";
import { defaultChart } from "./model";
import TableSettings from "./TableSettings";
import { createTableSpec } from "./tableModel";
export default function Inspector({
  node,
  result,
  editable,
  change,
  close,
  openSource,
}: {
  node: BoardNode;
  result?: ResultSet;
  editable: boolean;
  change: (node: BoardNode) => void;
  close: () => void;
  openSource: () => void;
}) {
  return (
    <aside
      className="board-inspector nodrag nopan nowheel"
      aria-label="Свойства блока"
    >
      <header>
        <strong>Свойства блока</strong>
        <button aria-label="Закрыть свойства" onClick={close}>
          ×
        </button>
      </header>
      <div className="board-inspector-body">
        <label>
          Название
          <input
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
                aria-pressed={node.data.view !== "chart"}
                onClick={() =>
                  change({ ...node, data: { ...node.data, view: "table" } })
                }
              >
                Таблица
              </button>
              <button
                disabled={!editable || !result}
                aria-pressed={node.data.view === "chart"}
                onClick={() =>
                  change({
                    ...node,
                    data: {
                      ...node.data,
                      view: "chart",
                      chart: node.data.chart ?? defaultChart(result!.columns),
                    },
                  })
                }
              >
                График
              </button>
            </div>
            {node.data.view === "chart" && result && (
              <ChartSettings
                result={result}
                spec={node.data.chart ?? defaultChart(result.columns)}
                disabled={!editable}
                onChange={(chart) => {
                  if (editable)
                    change({ ...node, data: { ...node.data, chart } });
                }}
              />
            )}
            {node.data.view !== "chart" && result && (
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
            <p className="board-source-note">
              Закреплённый SQL · версия {node.data.sourceRevision ?? 1}
              <br />
              Снимок {node.data.resultSetId?.slice(0, 8)}
            </p>
            {node.data.source && (
              <button className="board-open-source" onClick={openSource}>
                Открыть SQL в редакторе
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
