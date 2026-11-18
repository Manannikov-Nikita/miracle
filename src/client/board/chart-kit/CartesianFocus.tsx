import { truncateTick } from "./cartesian-geometry";
import { type Geometry, type Sample } from "./cartesian-focus";

function CategoryChip({
  g,
  category,
  width,
  height,
}: {
  g: Geometry;
  category: number;
  width: number;
  height: number;
}) {
  if (!(g.horizontal ? g.showY : g.showX)) return null;
  const name = g.categories[category];
  // Allow a skipped tick to acquire a label without hiding neighbouring categories.
  const limit = Math.max(
    0,
    Math.min(g.horizontal ? g.axisLeft - 6 : width - 6, 125),
  );
  if (limit < 18) return null;
  const text = truncateTick(name, limit - 12);
  const chipWidth = Math.min(limit, Math.max(22, [...text].length * 7.4 + 13));
  const chipHeight = 18;
  const left = g.horizontal
    ? g.axisLeft - 3 - chipWidth
    : Math.max(
        2,
        Math.min(width - chipWidth - 2, g.center(category) - chipWidth / 2),
      );
  const top = Math.max(
    0,
    Math.min(
      height - chipHeight,
      g.horizontal
        ? g.center(category) - chipHeight / 2
        : g.bottom + g.bottomGutter + 2,
    ),
  );
  return (
    <g
      className="bk-category-chip"
      style={{ transform: `translate(${left + chipWidth / 2}px, ${top}px)` }}
      aria-hidden="true"
    >
      <rect
        x={-chipWidth / 2}
        width={chipWidth}
        height={chipHeight}
        rx={chipHeight / 2}
      />
      <text
        x={0}
        y={chipHeight / 2}
        dominantBaseline="central"
        textAnchor="middle"
      >
        {text}
      </text>
    </g>
  );
}

export default function CartesianFocus({
  g,
  category,
  shared,
  highlighted,
  width,
  height,
}: {
  g: Geometry;
  category: number;
  shared: boolean;
  highlighted: Sample[];
  width: number;
  height: number;
}) {
  const center = g.center(category);
  const selected = highlighted[0];
  const guide = shared || selected?.mark.style !== "bar";
  return (
    <g className="bk-focus" aria-hidden="true">
      {guide && (
        <g
          className="bk-focus-guide"
          style={{
            transform: g.horizontal
              ? `translateY(${center}px)`
              : `translateX(${center}px)`,
          }}
        >
          <line
            className="bk-crosshair"
            x1={g.horizontal ? g.left : 0}
            x2={g.horizontal ? g.right : 0}
            y1={g.horizontal ? 0 : g.top}
            y2={g.horizontal ? 0 : g.bottom}
          />
        </g>
      )}
      {!shared && selected?.mark.stroke && (
        <g>
          {selected.mark.fill && (
            <path
              d={selected.mark.fill}
              fill={selected.mark.color}
              fillOpacity=".15"
            />
          )}
          <path
            d={selected.mark.stroke}
            fill="none"
            stroke={selected.mark.color}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}
      {highlighted.map((sample) => (
        <circle
          key={shared ? sample.key : "selected"}
          className="bk-focus-dot"
          style={{ transform: `translate(${sample.x}px, ${sample.y}px)` }}
          r="4.2"
          fill={sample.color}
        />
      ))}
      <CategoryChip g={g} category={category} width={width} height={height} />
    </g>
  );
}
