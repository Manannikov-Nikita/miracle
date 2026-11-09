import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { resolveShape, type ShapeSpec } from "../../shared/shapes";
import "./LineShapeContent.css";

type Point = { x: number; y: number };

function arrowPoints(tip: Point, toward: Point, length: number) {
  const distance = Math.hypot(toward.x - tip.x, toward.y - tip.y);
  const dx = (toward.x - tip.x) / (distance || 1);
  const dy = (toward.y - tip.y) / (distance || 1);
  const halfWidth = length * 0.45;
  const base = { x: tip.x + dx * length, y: tip.y + dy * length };
  return [
    tip,
    { x: base.x - dy * halfWidth, y: base.y + dx * halfWidth },
    { x: base.x + dy * halfWidth, y: base.y - dx * halfWidth },
  ]
    .map(({ x, y }) => `${x},${y}`)
    .join(" ");
}

export default function LineShapeContent({ shape }: { shape: ShapeSpec }) {
  const spec = resolveShape(shape);
  const content = useRef<HTMLDivElement>(null);
  const gradientId = useId();
  const [size, setSize] = useState({ width: 260, height: 40 });
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const update = (width: number, height: number) => {
      if (!(width > 0 && height > 0)) return;
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    // Client/content dimensions exclude the board's zoom transform. Measuring
    // the screen bounds here would stretch arrowheads whenever zoom changes.
    update(element.clientWidth, element.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const startArrow = spec.lineStart === "arrow" && spec.strokeWidth > 0;
  const endArrow = spec.lineEnd === "arrow" && spec.strokeWidth > 0;
  const desiredHead = Math.min(
    Math.max(8, spec.strokeWidth * 4),
    Math.min(size.width, size.height) * 0.35,
  );
  const padding = Math.min(
    spec.strokeWidth / 2 +
      1 +
      (startArrow || endArrow ? desiredHead * 0.45 : 0),
    size.width / 3,
    size.height / 3,
  );
  let start: Point;
  let end: Point;
  if (spec.lineDirection === "vertical") {
    start = { x: size.width / 2, y: padding };
    end = { x: size.width / 2, y: size.height - padding };
  } else if (spec.lineDirection === "diagonal-down") {
    start = { x: padding, y: padding };
    end = { x: size.width - padding, y: size.height - padding };
  } else if (spec.lineDirection === "diagonal-up") {
    start = { x: padding, y: size.height - padding };
    end = { x: size.width - padding, y: padding };
  } else {
    start = { x: padding, y: size.height / 2 };
    end = { x: size.width - padding, y: size.height / 2 };
  }
  const headLength = Math.min(
    desiredHead,
    Math.hypot(end.x - start.x, end.y - start.y) /
      (startArrow && endArrow ? 3 : 2),
  );
  const distance = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const dx = (end.x - start.x) / distance;
  const dy = (end.y - start.y) / distance;
  // Stop at the heads' bases: a full-width shaft reaching the point would
  // protrude beside its tip and make the arrow look blunt.
  const shaftStart = startArrow
    ? { x: start.x + dx * headLength, y: start.y + dy * headLength }
    : start;
  const shaftEnd = endArrow
    ? { x: end.x - dx * headLength, y: end.y - dy * headLength }
    : end;
  const dash =
    spec.strokeStyle === "dashed"
      ? `${spec.strokeWidth * 4} ${spec.strokeWidth * 2}`
      : spec.strokeStyle === "dotted"
        ? `0 ${spec.strokeWidth * 2.5}`
        : undefined;
  const workStyle = {
    "--agent-shape-stroke": `url(#${gradientId})`,
  } as CSSProperties;

  return (
    <div
      ref={content}
      className="board-shape-content board-shape-line"
      style={{ opacity: spec.opacity }}
    >
      <svg
        className="board-shape-outline board-line-outline"
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient
            id={gradientId}
            className="board-shape-work-gradient"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={size.height / 2}
            x2={size.width}
            y2={size.height / 2}
            style={{
              transformOrigin: `${size.width / 2}px ${size.height / 2}px`,
            }}
          >
            <stop offset="0%" />
            <stop offset="50%" />
            <stop offset="80%" />
            <stop offset="100%" />
          </linearGradient>
        </defs>
        <line
          className="board-line-shaft"
          x1={shaftStart.x}
          y1={shaftStart.y}
          x2={shaftEnd.x}
          y2={shaftEnd.y}
          fill="none"
          stroke={spec.stroke}
          strokeWidth={spec.strokeWidth}
          strokeDasharray={dash}
          strokeLinecap={spec.strokeStyle === "dotted" ? "round" : "butt"}
          vectorEffect="non-scaling-stroke"
          style={workStyle}
        />
        {startArrow && (
          <polygon
            className="board-line-arrow board-line-arrow-start"
            points={arrowPoints(start, end, headLength)}
            fill={spec.stroke}
            stroke="none"
            style={workStyle}
          />
        )}
        {endArrow && (
          <polygon
            className="board-line-arrow board-line-arrow-end"
            points={arrowPoints(end, start, headLength)}
            fill={spec.stroke}
            stroke="none"
            style={workStyle}
          />
        )}
      </svg>
    </div>
  );
}
