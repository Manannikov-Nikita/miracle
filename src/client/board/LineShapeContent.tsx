import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { resolveShape, type ShapeSpec } from "../../shared/shapes";
import { getLineGeometry, type Point } from "./shape-geometry";
import "./LineShapeContent.css";

const pointsAttribute = (points: Point[]) =>
  points.map(({ x, y }) => `${x},${y}`).join(" ");

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

  const { start, end, shaftStart, shaftEnd, startHead, endHead } =
    getLineGeometry(spec, size.width, size.height);
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
          className="board-line-hit"
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          stroke="transparent"
          pointerEvents="stroke"
        />
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
          pointerEvents="visiblePainted"
          style={workStyle}
        />
        {startHead && (
          <polygon
            className="board-line-arrow board-line-arrow-start"
            points={pointsAttribute(startHead)}
            fill={spec.stroke}
            stroke="none"
            pointerEvents="visiblePainted"
            style={workStyle}
          />
        )}
        {endHead && (
          <polygon
            className="board-line-arrow board-line-arrow-end"
            points={pointsAttribute(endHead)}
            fill={spec.stroke}
            stroke="none"
            pointerEvents="visiblePainted"
            style={workStyle}
          />
        )}
      </svg>
    </div>
  );
}
