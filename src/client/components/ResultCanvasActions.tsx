import { useState } from "react";
import { Presentation, SquaresFour } from "@phosphor-icons/react";
import type { BoardKind, ResultSet } from "../../shared/types";
import { useCanvasWorkspace } from "../canvas-workspace";
import { suggestDatasetName } from "../../shared/datasets";
import { useDatasetCatalog } from "../dataset-catalog";
import DatasetNameDialog from "./DatasetNameDialog";
import { IconButton } from "./UI";

export default function ResultCanvasActions({
  result,
  queryName,
  disabled,
  onBoardFallback,
  onNotify,
}: {
  result: ResultSet;
  queryName?: string;
  disabled: boolean;
  onBoardFallback(result: ResultSet, datasetName: string): void;
  onNotify(message: string, tone?: "error" | "success" | "info"): void;
}) {
  const registry = useCanvasWorkspace();
  const catalog = useDatasetCatalog();
  const existingDataset = catalog?.items.find(
    (dataset) => dataset.resultSetId === result.id,
  );
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  async function add(kind: BoardKind, datasetName?: string) {
    if (busy || disabled) return;
    if (!registry) {
      if (kind === "board" && datasetName) onBoardFallback(result, datasetName);
      return;
    }
    setBusy(true);
    try {
      await registry.addResult(kind, result, datasetName);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <IconButton
        label="Добавить результат на доску"
        className="add-to-board"
        disabled={disabled || busy}
        draggable={!disabled && !busy}
        title={
          disabled
            ? "Дождитесь завершения серии, чтобы закрепить снимок"
            : "Добавить на доску · можно перетащить в нужное место"
        }
        onClick={() => {
          if (existingDataset)
            void add("board", existingDataset.name).catch((error: Error) =>
              onNotify(error.message, "error"),
            );
          else setNaming(true);
        }}
        onDragStart={(event) => {
          if (disabled || busy) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData(
            "application/x-miracle-result",
            JSON.stringify({ ...result, datasetTitle: queryName }),
          );
          event.dataTransfer.effectAllowed = "copy";
        }}
      >
        <SquaresFour size={17} />
      </IconButton>
      {registry && (
        <IconButton
          label="Добавить результат в презентацию"
          disabled={disabled || busy}
          title={
            disabled
              ? "Дождитесь завершения серии, чтобы закрепить снимок"
              : "Добавить на выбранный слайд презентации"
          }
          onClick={() =>
            void add("presentation").catch((error: Error) =>
              onNotify(error.message, "error"),
            )
          }
        >
          <Presentation size={17} />
        </IconButton>
      )}
      {naming && (
        <DatasetNameDialog
          title="Добавить результат на доску"
          initialName={suggestDatasetName(
            queryName?.replace(/\.sql$/i, "") || "dataset",
            catalog?.items.map(({ name }) => name) ?? [],
          )}
          confirmLabel="Добавить на доску"
          onConfirm={(name) => add("board", name)}
          onClose={() => setNaming(false)}
        />
      )}
    </>
  );
}
