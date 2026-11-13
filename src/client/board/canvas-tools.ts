import type { BoardNode } from "../../shared/types";
import { SHAPE_OPTIONS, type ShapeKind } from "../../shared/shapes";
import { createEmptyVisualTable } from "../../shared/visual-table";

export type CanvasTool =
  | { kind: "shape"; shape: ShapeKind }
  | { kind: "text" | "note" | "markdown" | "image" | "table" };
export type CanvasPoint = { x: number; y: number };

/** Shared defaults keep the dragged preview and the inserted block identical. */
export function createToolNode(
  tool: CanvasTool,
  center: CanvasPoint,
  options: { id: string; slideId?: string; textColor?: string },
): BoardNode | null {
  if (tool.kind === "image") return null;
  if (tool.kind === "table")
    return {
      id: options.id,
      type: "artifact",
      slideId: options.slideId,
      position: { x: center.x - 380, y: center.y - 210 },
      width: 760,
      height: 420,
      data: {
        kind: "table",
        title: "Таблица",
        visualTable: createEmptyVisualTable(),
      },
    };
  const shape = tool.kind === "shape" ? tool.shape : undefined;
  const square = shape === "triangle" || shape === "diamond";
  const width = shape ? (shape === "line" ? 260 : square ? 180 : 240) : 360;
  const height = shape
    ? shape === "line"
      ? 40
      : square
        ? 180
        : 160
    : tool.kind === "text"
      ? 120
      : 260;
  return {
    id: options.id,
    type: "artifact",
    slideId: options.slideId,
    position: { x: center.x - width / 2, y: center.y - height / 2 },
    width,
    height,
    data: {
      kind: tool.kind,
      title: shape
        ? SHAPE_OPTIONS.find((item) => item.type === shape)!.label
        : tool.kind === "text"
          ? "Текст"
          : tool.kind === "note"
            ? "Заметка"
            : "Markdown",
      text:
        tool.kind === "markdown"
          ? "## Наблюдение\n\nДобавьте контекст к данным."
          : tool.kind === "text"
            ? "Текст"
            : "",
      ...(shape && { shape: { type: shape } }),
      ...(tool.kind === "text" && {
        textStyle: {
          fontFamily: "sans" as const,
          fontSize: 32,
          textAlign: "left" as const,
          verticalAlign: "top" as const,
          textColor: options.textColor ?? "#eeeff0",
        },
      }),
    },
  };
}
