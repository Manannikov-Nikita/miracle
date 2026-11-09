import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { ResizeRectangle } from "./resize-aspect";
import type { ResizeSides } from "./resize-snapping";
import {
  normalizeRotation,
  pointerRotation,
  rotatedResize,
  snapRotation,
} from "./shape-rotation";
import "./ShapeTransformControls.css";

export type ShapeTransformPatch = {
  rotation?: number;
  rectangle?: ResizeRectangle;
};

type Props = {
  rotation: number;
  zoom: number;
  rectangle: ResizeRectangle;
  onStart: () => boolean;
  onChange: (patch: ShapeTransformPatch) => void;
  onEnd: (cancelled: boolean) => void;
};

const resizeHandles: {
  position: string;
  label: string;
  sides: ResizeSides;
  angle: number;
}[] = [
  {
    position: "top-left",
    label: "Изменить размер слева сверху",
    sides: { left: true, top: true },
    angle: 45,
  },
  {
    position: "top",
    label: "Изменить размер сверху",
    sides: { top: true },
    angle: 90,
  },
  {
    position: "top-right",
    label: "Изменить размер справа сверху",
    sides: { right: true, top: true },
    angle: 135,
  },
  {
    position: "right",
    label: "Изменить размер справа",
    sides: { right: true },
    angle: 0,
  },
  {
    position: "bottom-right",
    label: "Изменить размер справа снизу",
    sides: { right: true, bottom: true },
    angle: 45,
  },
  {
    position: "bottom",
    label: "Изменить размер снизу",
    sides: { bottom: true },
    angle: 90,
  },
  {
    position: "bottom-left",
    label: "Изменить размер слева снизу",
    sides: { left: true, bottom: true },
    angle: 135,
  },
  {
    position: "left",
    label: "Изменить размер слева",
    sides: { left: true },
    angle: 0,
  },
];

export default function ShapeTransformControls({
  rotation,
  zoom,
  rectangle,
  onStart,
  onChange,
  onEnd,
}: Props) {
  const activeEnd = useRef<((cancelled: boolean) => void) | null>(null);
  useEffect(() => () => activeEnd.current?.(true), []);

  function begin(event: PointerEvent<HTMLButtonElement>, sides?: ResizeSides) {
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0 || activeEnd.current) return;
    const target = event.currentTarget;
    const article = target.closest(".board-artifact");
    if (!article || !onStart()) return;
    const bounds = article.getBoundingClientRect();
    const center = {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    const startPointer = { x: event.clientX, y: event.clientY };
    const initialAngle = pointerRotation(center, startPointer);
    const initialRotation = rotation;
    const initialRectangle = { ...rectangle };
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const pointerId = event.pointerId;
    const change = onChange;
    const end = onEnd;
    let latestPointer = startPointer;
    let ended = false;

    function update(shift: boolean) {
      if (ended) return;
      if (sides) {
        change({
          rectangle: rotatedResize(
            initialRectangle,
            initialRotation,
            sides,
            {
              x: (latestPointer.x - startPointer.x) / scale,
              y: (latestPointer.y - startPointer.y) / scale,
            },
            40,
            shift,
          ),
        });
      } else if (
        Math.hypot(latestPointer.x - center.x, latestPointer.y - center.y) >= 1
      ) {
        change({
          rotation: snapRotation(
            initialRotation +
              pointerRotation(center, latestPointer) -
              initialAngle,
            shift,
          ),
        });
      }
    }
    function move(next: globalThis.PointerEvent) {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      next.stopPropagation();
      latestPointer = { x: next.clientX, y: next.clientY };
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
      /* Global listeners also cover pointers without capture. */
    }
  }

  function rotateByKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    if (!direction && event.key !== "Home") return;
    event.preventDefault();
    event.stopPropagation();
    if (activeEnd.current || !onStart()) return;
    const current = normalizeRotation(rotation);
    const next =
      event.key === "Home"
        ? 0
        : event.shiftKey
          ? (direction > 0
              ? Math.floor(current / 15) + 1
              : Math.ceil(current / 15) - 1) * 15
          : current + direction;
    onChange({ rotation: normalizeRotation(next) });
    onEnd(false);
  }

  return (
    <div className="shape-transform-controls nodrag nopan nokey">
      {normalizeRotation(rotation) !== 0 && (
        <>
          <div className="shape-transform-frame" aria-hidden="true" />
          {resizeHandles.map((handle) => (
            <button
              key={handle.position}
              type="button"
              className={`shape-transform-resize shape-transform-resize-${handle.position} nodrag nopan nokey`}
              aria-label={handle.label}
              tabIndex={-1}
              style={{
                cursor: [
                  "ew-resize",
                  "nwse-resize",
                  "ns-resize",
                  "nesw-resize",
                ][
                  Math.round(normalizeRotation(rotation + handle.angle) / 45) %
                    4
                ],
              }}
              onPointerDown={(event) => begin(event, handle.sides)}
              onClick={(event) => event.stopPropagation()}
            />
          ))}
        </>
      )}
      <button
        type="button"
        className="shape-rotation-handle nodrag nopan nokey"
        aria-label="Повернуть фигуру"
        aria-description="Перетащите для поворота. Shift — шаг 15°. Стрелки — шаг 1°, Home — сброс."
        title={`Поворот ${Math.round(normalizeRotation(rotation))}° · Shift — шаг 15°`}
        onPointerDown={(event) => begin(event)}
        onKeyDown={rotateByKeyboard}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
