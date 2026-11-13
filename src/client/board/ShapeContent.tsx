import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type SVGAttributes,
  type SyntheticEvent,
} from "react";
import {
  resolveShape,
  type ShapeKind,
  type ShapeSpec,
} from "../../shared/shapes";
import "./shapes.css";
import LineShapeContent from "./LineShapeContent";
import { SHAPE_POLYGON_POINTS } from "./shape-geometry";

const polygonPoints = (type: ShapeKind) =>
  SHAPE_POLYGON_POINTS[type]?.map(({ x, y }) => `${x},${y}`).join(" ");
const fontFamilies = {
  sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
};

function Geometry({
  type,
  cornerRadius = 0,
  ...appearance
}: SVGAttributes<SVGElement> & { type: ShapeKind; cornerRadius?: number }) {
  if (type === "line")
    return <line x1="5" y1="50" x2="95" y2="50" {...appearance} />;
  if (type === "ellipse")
    return <ellipse cx="50" cy="50" rx="50" ry="50" {...appearance} />;
  if (type === "rectangle" || type === "rounded-rectangle")
    return <rect width="100" height="100" rx={cornerRadius} {...appearance} />;
  return <polygon points={polygonPoints(type)} {...appearance} />;
}

export function ShapeGlyph({
  type,
  className,
  size = 20,
}: {
  type: ShapeKind;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="-5 -5 110 110"
      aria-hidden="true"
      focusable="false"
    >
      <Geometry
        type={type}
        cornerRadius={type === "rounded-rectangle" ? 16 : 0}
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function clipPath(type: ShapeKind, cornerRadius: number) {
  if (type === "ellipse") return "ellipse(50% 50% at 50% 50%)";
  if (type === "rectangle" || type === "rounded-rectangle")
    return `inset(0 round ${cornerRadius}%)`;
  return `polygon(${SHAPE_POLYGON_POINTS[type]!.map(
    ({ x, y }) => `${x}% ${y}%`,
  ).join(", ")})`;
}

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

type ShapeContentProps = {
  text: string;
  shape?: ShapeSpec;
  editable: boolean;
  onChange: (text: string) => void;
};

export default function ShapeContent(props: ShapeContentProps) {
  return props.shape?.type === "line" ? (
    <LineShapeContent shape={props.shape} />
  ) : (
    <TextShapeContent {...props} />
  );
}

function TextShapeContent({
  text,
  shape,
  editable,
  onChange,
}: ShapeContentProps) {
  const spec = resolveShape(shape);
  const workGradientId = useId();
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const isEditing = editable && editing;

  useLayoutEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  useLayoutEffect(() => {
    if (isEditing) editor.current?.focus({ preventScroll: true });
  }, [isEditing]);
  useLayoutEffect(() => {
    const input = editor.current;
    if (!isEditing || !input) return;
    const fit = () => {
      input.style.height = "0px";
      input.style.height = `${input.scrollHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (input.parentElement) observer.observe(input.parentElement);
    return () => observer.disconnect();
  }, [isEditing, text, spec.fontSize, spec.fontFamily]);

  const textStyle: CSSProperties = {
    color: spec.textColor,
    fontSize: spec.fontSize,
    fontFamily: fontFamilies[spec.fontFamily],
    fontWeight: spec.bold ? 700 : 400,
    fontStyle: spec.italic ? "italic" : "normal",
    textDecoration: spec.underline ? "underline" : "none",
    textAlign: spec.textAlign,
    justifyContent:
      spec.verticalAlign === "top"
        ? "flex-start"
        : spec.verticalAlign === "bottom"
          ? "flex-end"
          : "center",
  };
  const dash =
    spec.strokeStyle === "dashed"
      ? `${spec.strokeWidth * 4} ${spec.strokeWidth * 2}`
      : spec.strokeStyle === "dotted"
        ? `0 ${spec.strokeWidth * 2.5}`
        : undefined;

  return (
    <div
      className={`board-shape-content board-shape-${spec.type}${isEditing ? " board-shape-editing" : ""}`}
      style={{ opacity: spec.opacity }}
      onDoubleClick={(event) => {
        if (!editable) return;
        event.stopPropagation();
        setEditing(true);
      }}
    >
      <svg
        className="board-shape-outline"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        style={{
          inset: spec.strokeWidth / 2,
          width: `calc(100% - ${spec.strokeWidth}px)`,
          height: `calc(100% - ${spec.strokeWidth}px)`,
        }}
      >
        <defs>
          <linearGradient
            id={workGradientId}
            className="board-shape-work-gradient"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="50"
            x2="100"
            y2="50"
          >
            <stop offset="0%" />
            <stop offset="50%" />
            <stop offset="80%" />
            <stop offset="100%" />
          </linearGradient>
        </defs>
        <Geometry
          type={spec.type}
          cornerRadius={spec.cornerRadius}
          fill={spec.fill}
          stroke={spec.stroke}
          style={
            {
              "--agent-shape-stroke": `url(#${workGradientId})`,
            } as CSSProperties
          }
          strokeWidth={spec.strokeWidth}
          strokeDasharray={dash}
          strokeLinecap={spec.strokeStyle === "dotted" ? "round" : "butt"}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div
        className="board-shape-text-clip"
        style={{ clipPath: clipPath(spec.type, spec.cornerRadius) }}
      >
        <div className="board-shape-text-area" style={textStyle}>
          {isEditing ? (
            <textarea
              ref={editor}
              className="board-shape-editor nodrag nopan nowheel nokey"
              aria-label="Текст фигуры"
              value={text}
              rows={1}
              maxLength={200000}
              onChange={(event) => {
                event.stopPropagation();
                if (editable) onChange(event.target.value);
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              onKeyUp={stopPropagation}
              onPointerDown={stopPropagation}
              onPointerUp={stopPropagation}
              onMouseDown={stopPropagation}
              onMouseUp={stopPropagation}
              onClick={stopPropagation}
              onDoubleClick={stopPropagation}
              onCopy={stopPropagation}
              onCut={stopPropagation}
              onPaste={stopPropagation}
            />
          ) : (
            <div className="board-shape-text">{text}</div>
          )}
        </div>
      </div>
    </div>
  );
}
