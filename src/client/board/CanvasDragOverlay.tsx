import { createPortal } from "react-dom";
import type { BoardNode } from "../../shared/types";
import "./canvas-drag-overlay.css";

export default function CanvasDragOverlay({
  nodes,
  origin,
  viewport,
}: {
  nodes: BoardNode[];
  origin: { left: number; top: number };
  viewport: { x: number; y: number; zoom: number };
}) {
  return createPortal(
    <div className="canvas-drag-overlay" aria-hidden="true">
      {nodes.map((node) => (
        <div
          key={node.id}
          className="canvas-drag-skeleton"
          style={{
            left: origin.left + viewport.x + node.position.x * viewport.zoom,
            top: origin.top + viewport.y + node.position.y * viewport.zoom,
            width: (node.width ?? 480) * viewport.zoom,
            height: (node.height ?? 300) * viewport.zoom,
            ...(node.data.kind === "shape" && {
              transform: `rotate(${node.data.shape?.rotation ?? 0}deg)`,
            }),
          }}
        >
          <span>{node.data.title}</span>
          <i />
          <i />
          <i />
        </div>
      ))}
    </div>,
    document.body,
  );
}
