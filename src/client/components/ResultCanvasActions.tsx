import { useState } from "react";
import { Presentation, SquaresFour } from "@phosphor-icons/react";
import type { BoardKind, ResultSet } from "../../shared/types";
import { useCanvasWorkspace } from "../canvas-workspace";
import { IconButton } from "./UI";

export default function ResultCanvasActions({
  result,
  disabled,
  onBoardFallback,
  onNotify,
}: {
  result: ResultSet;
  disabled: boolean;
  onBoardFallback(result: ResultSet): void;
  onNotify(message: string, tone?: "error" | "success" | "info"): void;
}) {
  const registry = useCanvasWorkspace();
  const [busy, setBusy] = useState(false);
  async function add(kind: BoardKind) {
    if (busy || disabled) return;
    if (!registry) {
      if (kind === "board") onBoardFallback(result);
      return;
    }
    setBusy(true);
    try {
      await registry.addResult(kind, result);
    } catch (error) {
      onNotify((error as Error).message, "error");
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
        onClick={() => void add("board")}
        onDragStart={(event) => {
          if (disabled || busy) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData(
            "application/x-miracle-result",
            JSON.stringify(result),
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
          onClick={() => void add("presentation")}
        >
          <Presentation size={17} />
        </IconButton>
      )}
    </>
  );
}
