import { useViewport } from "@xyflow/react";
import type { AlignmentGuide } from "./alignment";

function SpacingGuide({
  guide,
  x,
  y,
  zoom,
}: {
  guide: AlignmentGuide;
  x: number;
  y: number;
  zoom: number;
}) {
  const horizontal = guide.axis === "x";
  const x1 = x + (horizontal ? guide.from : guide.coordinate) * zoom;
  const y1 = y + (horizontal ? guide.coordinate : guide.from) * zoom;
  const x2 = x + (horizontal ? guide.to : guide.coordinate) * zoom;
  const y2 = y + (horizontal ? guide.coordinate : guide.to) * zoom;
  return (
    <g className="board-spacing-guide" data-axis={guide.axis}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      {[
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ].map((point, index) => (
        <line
          key={index}
          x1={point.x - (horizontal ? 0 : 4)}
          y1={point.y - (horizontal ? 4 : 0)}
          x2={point.x + (horizontal ? 0 : 4)}
          y2={point.y + (horizontal ? 4 : 0)}
        />
      ))}
    </g>
  );
}

export function AlignmentGuides({ guides }: { guides: AlignmentGuide[] }) {
  const { x, y, zoom } = useViewport();
  if (!guides.length) return null;
  return (
    <svg className="board-alignment-guides" aria-hidden="true">
      {guides.map((guide, index) =>
        guide.kind === "spacing" ? (
          <SpacingGuide
            key={`spacing-${guide.axis}-${guide.from}-${guide.to}-${index}`}
            guide={guide}
            x={x}
            y={y}
            zoom={zoom}
          />
        ) : (
          <line
            key={`${guide.axis}-${guide.coordinate}-${index}`}
            x1={x + (guide.axis === "x" ? guide.coordinate : guide.from) * zoom}
            y1={y + (guide.axis === "y" ? guide.coordinate : guide.from) * zoom}
            x2={x + (guide.axis === "x" ? guide.coordinate : guide.to) * zoom}
            y2={y + (guide.axis === "y" ? guide.coordinate : guide.to) * zoom}
          />
        ),
      )}
    </svg>
  );
}
