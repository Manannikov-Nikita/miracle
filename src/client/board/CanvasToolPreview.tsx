import { useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ImageSquare } from "@phosphor-icons/react";
import {
  createToolNode,
  type CanvasPoint,
  type CanvasTool,
} from "./canvas-tools";
import ShapeContent from "./ShapeContent";
import TextBlockContent from "./TextBlockContent";
import StickyNoteEditor from "./StickyNoteEditor";
import MarkdownEditor from "./MarkdownEditor";
import { presentationColors } from "./presentation-colors";
import "./canvas-tool-preview.css";

const ignoreChange = () => {};

export default function CanvasToolPreview({
  tool,
  point,
  zoom,
  presentation = false,
  background = "#ffffff",
}: {
  tool: CanvasTool;
  point: CanvasPoint;
  zoom: number;
  presentation?: boolean;
  background?: string;
}) {
  const colors = presentation ? presentationColors(background) : undefined;
  const node = useMemo(
    () =>
      createToolNode(
        tool,
        { x: 0, y: 0 },
        { id: "canvas-tool-preview", textColor: colors?.text },
      ),
    [tool, colors?.text],
  );
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const style = {
    left: point.x,
    top: point.y,
    width: node?.width,
    height: node?.height,
    transform: `translate(-50%, -50%)${node ? ` scale(${scale})` : ""}`,
    ...(node &&
      colors && {
        "--board-text": colors.text,
        "--board-muted": colors.muted,
        "--board-border": colors.grid,
        "--board-border-subtle": colors.grid,
        "--board-raised": colors.raised,
        "--board-accent": colors.accent,
      }),
  } as CSSProperties;

  return createPortal(
    <div
      className="canvas-tool-preview board-workspace"
      style={style}
      aria-hidden="true"
      inert
    >
      {node ? (
        <article
          className={`board-artifact board-artifact-${node.data.kind}${presentation ? " presentation-artifact" : ""}`}
        >
          {!presentation &&
            (tool.kind === "note" ||
              tool.kind === "markdown" ||
              tool.kind === "table") && (
              <header className="board-node-header">
                {tool.kind !== "note" && <strong>{node.data.title}</strong>}
              </header>
            )}
          <div className="board-node-body">
            {node.data.kind === "table" && (
              <table className="board-table-tool-preview">
                <thead>
                  <tr>
                    {node.data.visualTable?.columns.map((column) => (
                      <th key={column.id}>{column.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {node.data.visualTable?.rows?.map((row) => (
                    <tr key={row.id}>
                      {node.data.visualTable?.columns.map((column) => (
                        <td key={column.id}>—</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {node.data.kind === "shape" && (
              <ShapeContent
                shape={node.data.shape}
                text={node.data.text ?? ""}
                editable={false}
                onChange={ignoreChange}
              />
            )}
            {node.data.kind === "text" && (
              <TextBlockContent
                text={node.data.text ?? ""}
                textStyle={{ ...node.data.textStyle, textColor: colors?.text }}
                editable={false}
                onChange={ignoreChange}
              />
            )}
            {node.data.kind === "note" && (
              <StickyNoteEditor
                value={node.data.text ?? ""}
                readOnly
                onChange={ignoreChange}
              />
            )}
            {node.data.kind === "markdown" && (
              <MarkdownEditor
                value={node.data.text ?? ""}
                readOnly
                onChange={ignoreChange}
              />
            )}
          </div>
        </article>
      ) : (
        <div className="canvas-tool-preview-image">
          <ImageSquare size={20} aria-hidden="true" />
          <span>Выбрать изображение</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
