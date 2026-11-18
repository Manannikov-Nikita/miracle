import { truncateTick } from "./cartesian-geometry";
import { barRect, type Geometry, type Sample } from "./cartesian-focus";

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
      transform={`translate(${left} ${top})`}
      aria-hidden="true"
    >
      <rect width={chipWidth} height={chipHeight} rx={chipHeight / 2} />
      <text
        x={chipWidth / 2}
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
  sample,
  width,
  height,
}: {
  g: Geometry;
  category: number;
  sample?: Sample;
  width: number;
  height: number;
}) {
  const center = g.center(category);
  const marked = sample && sample.point.value !== null ? sample : undefined;
  const bar = marked?.mark.style === "bar";
  return (
    <g className="bk-focus" aria-hidden="true">
      {!bar && (
        <line
          className="bk-crosshair"
          x1={g.horizontal ? g.left : center}
          x2={g.horizontal ? g.right : center}
          y1={g.horizontal ? center : g.top}
          y2={g.horizontal ? center : g.bottom}
        />
      )}
      {marked && (
        <>
          {bar ? (
            <rect
              className="bk-active-bar"
              {...barRect(
                g,
                center + marked.mark.offset,
                g.scale(marked.point.value!),
              )}
              fill={marked.color}
            />
          ) : (
            <>
              {marked.mark.fill && (
                <path
                  d={marked.mark.fill}
                  fill={marked.mark.color}
                  fillOpacity=".15"
                />
              )}
              <path
                d={marked.mark.stroke}
                fill="none"
                stroke={marked.mark.color}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}
          <circle
            className="bk-focus-dot"
            cx={marked.x}
            cy={marked.y}
            r="4.2"
            fill={marked.color}
          />
        </>
      )}
      <CategoryChip g={g} category={category} width={width} height={height} />
    </g>
  );
}
