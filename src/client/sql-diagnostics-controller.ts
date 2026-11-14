import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { validateSql } from "./sql-diagnostics";

const owner = "miracle-sql-validation";
type Editor = Pick<
  Monaco.editor.IStandaloneCodeEditor,
  "getModel" | "onDidChangeModel" | "onDidChangeModelContent" | "onDidDispose"
>;
type Api = {
  editor: Pick<typeof Monaco.editor, "setModelMarkers">;
  MarkerSeverity: Pick<typeof Monaco.MarkerSeverity, "Error" | "Warning">;
};

/** Local advisory markers. Never mutates the buffer or initiates a query. */
export function attachSqlDiagnostics(
  editor: Editor,
  api: Api,
  getOptions: () => Parameters<typeof validateSql>[1],
) {
  let model: Monaco.editor.ITextModel | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const clear = (target: Monaco.editor.ITextModel | null) => {
    if (target && !target.isDisposed())
      api.editor.setModelMarkers(target, owner, []);
  };
  const refresh = () => {
    if (disposed) return;
    clearTimeout(timer);
    const next = editor.getModel();
    if (model !== next) clear(model);
    model = next;
    clear(model);
    if (!model || model.isDisposed()) return;
    const target = model;
    timer = setTimeout(() => {
      if (disposed || target.isDisposed() || editor.getModel() !== target)
        return;
      const diagnostics = validateSql(target.getValue(), getOptions());
      api.editor.setModelMarkers(
        target,
        owner,
        diagnostics.map((diagnostic) => {
          const start = target.getPositionAt(diagnostic.start);
          const end = target.getPositionAt(diagnostic.end);
          return {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
            message: diagnostic.message,
            source: "Предварительная проверка SQL",
            severity:
              diagnostic.severity === "error"
                ? api.MarkerSeverity.Error
                : api.MarkerSeverity.Warning,
          };
        }),
      );
    }, 350);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clear(model);
    for (const subscription of subscriptions) subscription.dispose();
  };
  const subscriptions = [
    editor.onDidChangeModel(refresh),
    editor.onDidChangeModelContent(refresh),
    editor.onDidDispose(dispose),
  ];
  refresh();
  return { refresh, dispose };
}
