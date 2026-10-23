import { useViewport } from "@xyflow/react";
import type { AlignmentGuide } from "./alignment";

export function AlignmentGuides({ guides }: { guides: AlignmentGuide[] }) {
  const { x, y, zoom } = useViewport();
  if (!guides.length) return null;
  return (
    <svg className="board-alignment-guides" aria-hidden="true">
      {guides.map((guide, index) => (
        <line
          key={`${guide.axis}-${guide.coordinate}-${index}`}
          x1={x + (guide.axis === "x" ? guide.coordinate : guide.from) * zoom}
          y1={y + (guide.axis === "y" ? guide.coordinate : guide.from) * zoom}
          x2={x + (guide.axis === "x" ? guide.coordinate : guide.to) * zoom}
          y2={y + (guide.axis === "y" ? guide.coordinate : guide.to) * zoom}
        />
      ))}
    </svg>
  );
}
