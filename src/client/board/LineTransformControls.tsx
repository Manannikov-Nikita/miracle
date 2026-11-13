import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { resolveShape, type ShapeSpec } from "../../shared/shapes";
import { getLineGeometry, type Point } from "./shape-geometry";
import { normalizeRotation, rotatePoint, snapRotation } from "./shape-rotation";
import type { ResizeRectangle } from "./resize-aspect";
import type { ShapeTransformPatch } from "./ShapeTransformControls";
import "./LineTransformControls.css";

type Endpoint = "start" | "end";
type Props = {
  shape: ShapeSpec;
  rectangle: ResizeRectangle;
  zoom: number;
  onStart: () => boolean;
  onChange: (patch: ShapeTransformPatch) => void;
  onEnd: (cancelled: boolean) => void;
};

function worldEndpoints(shape: ShapeSpec, rectangle: ResizeRectangle) {
  const geometry = getLineGeometry(shape, rectangle.width, rectangle.height);
  const center = { x: rectangle.width / 2, y: rectangle.height / 2 };
  const world = (point: Point) => {
    const rotated = rotatePoint(point, center, shape.rotation ?? 0);
    return { x: rectangle.x + rotated.x, y: rectangle.y + rotated.y };
  };
  return { start: world(geometry.start), end: world(geometry.end) };
}

/** Keep the opposite painted tip fixed while editing the line in board space. */
export function lineEndpointPatch(
  shape: ShapeSpec,
  rectangle: ResizeRectangle,
  endpoint: Endpoint,
  requested: Point,
  snap = false,
): ShapeTransformPatch {
  const spec = resolveShape(shape);
  const original = worldEndpoints(shape, rectangle);
  if (
    !snap &&
    Math.hypot(
      requested.x - original[endpoint].x,
      requested.y - original[endpoint].y,
    ) < 1e-9
  )
    return {
      rectangle: { ...rectangle },
      rotation: spec.rotation,
      lineDirection: spec.lineDirection,
    };
  const fixed = original[endpoint === "start" ? "end" : "start"];
  const sign = endpoint === "end" ? 1 : -1;
  const dx = (requested.x - fixed.x) * sign;
  const dy = (requested.y - fixed.y) * sign;
  const requestedLength = Math.hypot(dx, dy);
  const rotation = snapRotation(
    requestedLength > 1e-9
      ? (Math.atan2(dy, dx) * 180) / Math.PI
      : (Math.atan2(
          original.end.y - original.start.y,
          original.end.x - original.start.x,
        ) *
          180) /
          Math.PI,
    snap,
  );
  // Retain the original arrowhead size cap after canonicalizing a vertical or
  // diagonal line. The persisted frame remains a compatibility detail.
  const height = Math.min(
    10000,
    Math.max(40, Math.min(rectangle.width, rectangle.height)),
  );
  const horizontal: ShapeSpec = { ...shape, lineDirection: "horizontal" };
  const lengthAt = (width: number) => {
    const line = getLineGeometry(horizontal, width, height);
    return line.end.x - line.start.x;
  };
  let low = 40;
  let high = 10000;
  if (requestedLength <= lengthAt(low)) high = low;
  else if (requestedLength >= lengthAt(high)) low = high;
  else {
    // Padding depends on head size for very short lines. Solve the same
    // geometry used by painting instead of approximating its endpoint inset.
    for (let iteration = 0; iteration < 48; iteration++) {
      const middle = (low + high) / 2;
      if (lengthAt(middle) < requestedLength) low = middle;
      else high = middle;
    }
  }
  const width = (low + high) / 2;
  const radians = (rotation * Math.PI) / 180;
  const halfLength = (lengthAt(width) * sign) / 2;
  const center = {
    x: fixed.x + Math.cos(radians) * halfLength,
    y: fixed.y + Math.sin(radians) * halfLength,
  };
  return {
    lineDirection: "horizontal",
    rotation: normalizeRotation(rotation),
    rectangle: {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    },
  };
}

export default function LineTransformControls({
  shape,
  rectangle,
  zoom,
  onStart,
  onChange,
  onEnd,
}: Props) {
  const activeEnd = useRef<((cancelled: boolean) => void) | null>(null);
  useEffect(() => () => activeEnd.current?.(true), []);
  const geometry = getLineGeometry(shape, rectangle.width, rectangle.height);

  function begin(event: PointerEvent<HTMLButtonElement>, endpoint: Endpoint) {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeEnd.current || !onStart()) return;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    const original = worldEndpoints(shape, rectangle)[endpoint];
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const initialShape = shape;
    const initialRectangle = { ...rectangle };
    const change = onChange;
    const end = onEnd;
    let latest = start;
    let edited = false;
    let ended = false;
    function update(shift: boolean) {
      const dx = (latest.x - start.x) / scale;
      const dy = (latest.y - start.y) / scale;
      if (!edited && dx === 0 && dy === 0) return;
      edited = true;
      change(
        lineEndpointPatch(
          initialShape,
          initialRectangle,
          endpoint,
          { x: original.x + dx, y: original.y + dy },
          shift,
        ),
      );
    }
    function move(next: globalThis.PointerEvent) {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      next.stopPropagation();
      latest = { x: next.clientX, y: next.clientY };
      update(next.shiftKey);
    }
    function finish(cancelled: boolean) {
      if (ended) return;
      ended = true;
      activeEnd.current = null;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", blur, true);
      target.removeEventListener("lostpointercapture", lostCapture);
      if (target.hasPointerCapture?.(pointerId))
        target.releasePointerCapture(pointerId);
      end(cancelled);
    }
    function up(next: globalThis.PointerEvent) {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      next.stopPropagation();
      finish(false);
    }
    function cancel(next: globalThis.PointerEvent) {
      if (next.pointerId !== pointerId) return;
      next.stopPropagation();
      finish(true);
    }
    function key(next: globalThis.KeyboardEvent) {
      if (next.key === "Escape" && next.type === "keydown") {
        next.preventDefault();
        next.stopPropagation();
        finish(true);
      } else if (next.key === "Shift") {
        next.preventDefault();
        next.stopPropagation();
        update(next.type === "keydown");
      }
    }
    function blur() {
      finish(true);
    }
    function lostCapture() {
      finish(true);
    }
    activeEnd.current = finish;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", blur, true);
    target.addEventListener("lostpointercapture", lostCapture);
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      /* Global listeners cover uncaptured pointers. */
    }
  }

  function moveByKeyboard(
    event: KeyboardEvent<HTMLButtonElement>,
    endpoint: Endpoint,
  ) {
    const horizontal =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const vertical =
      event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!horizontal && !vertical) return;
    event.preventDefault();
    event.stopPropagation();
    if (activeEnd.current || !onStart()) return;
    const original = worldEndpoints(shape, rectangle)[endpoint];
    const step = event.shiftKey ? 10 : 1;
    onChange(
      lineEndpointPatch(shape, rectangle, endpoint, {
        x: original.x + horizontal * step,
        y: original.y + vertical * step,
      }),
    );
    onEnd(false);
  }

  return (
    <div className="line-transform-controls nodrag nopan nokey">
      {(["start", "end"] as const).map((endpoint) => (
        <button
          key={endpoint}
          type="button"
          data-line-endpoint={endpoint}
          className="line-transform-endpoint nodrag nopan nokey"
          aria-label={
            endpoint === "start"
              ? "Переместить начало линии"
              : "Переместить конец линии"
          }
          aria-description="Перетащите конец линии. Shift — угол с шагом 15°. Стрелки — сдвиг на 1, Shift со стрелкой — на 10."
          style={{ left: geometry[endpoint].x, top: geometry[endpoint].y }}
          onPointerDown={(event) => begin(event, endpoint)}
          onKeyDown={(event) => moveByKeyboard(event, endpoint)}
          onClick={(event) => event.stopPropagation()}
        />
      ))}
    </div>
  );
}
