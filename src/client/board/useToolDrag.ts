import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export type ToolDragPoint = { x: number; y: number };

type ToolDragOptions<T> = {
  onDrop: (tool: T, point: ToolDragPoint) => void;
  onMove?: (tool: T, point: ToolDragPoint) => void;
  onStart?: (tool: T) => void;
  onEnd?: () => void;
  disabled?: boolean;
  resetKey?: string;
};

type ToolDragGesture<T> = {
  tool: T;
  pointerId: number;
  origin: ToolDragPoint;
  started: boolean;
  cleanup: () => void;
};

const DRAG_THRESHOLD = 6;
const CLICK_SUPPRESSION_MS = 350;

export function useToolDrag<T>(options: ToolDragOptions<T>) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const gesture = useRef<ToolDragGesture<T> | null>(null);
  const suppressed = useRef(false);
  const suppressionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState<{
    tool: T;
    point: ToolDragPoint;
  } | null>(null);

  const clearSuppressionTimer = useCallback(() => {
    if (suppressionTimer.current !== null) {
      clearTimeout(suppressionTimer.current);
      suppressionTimer.current = null;
    }
  }, []);

  const expireSuppression = useCallback(() => {
    clearSuppressionTimer();
    suppressionTimer.current = setTimeout(() => {
      suppressed.current = false;
      suppressionTimer.current = null;
    }, CLICK_SUPPRESSION_MS);
  }, [clearSuppressionTimer]);

  const finish = useCallback(
    (dropPoint?: ToolDragPoint, updatePreview = true) => {
      const current = gesture.current;
      if (!current) return;
      gesture.current = null;
      current.cleanup();
      if (updatePreview) setPreview(null);
      if (current.started) {
        suppressed.current = true;
        clearSuppressionTimer();
        // Cancellation can happen while the pointer remains held. Keep its
        // eventual click suppressed until a new press begins.
        if (dropPoint) expireSuppression();
      }
      try {
        if (dropPoint && current.started)
          callbacks.current.onDrop(current.tool, dropPoint);
      } finally {
        callbacks.current.onEnd?.();
      }
    },
    [clearSuppressionTimer, expireSuppression],
  );

  const begin = useCallback(
    (event: ReactPointerEvent, tool: T) => {
      if (
        callbacks.current.disabled ||
        event.button !== 0 ||
        event.isPrimary === false
      )
        return;
      finish();
      clearSuppressionTimer();
      suppressed.current = false;
      const current: ToolDragGesture<T> = {
        tool,
        pointerId: event.pointerId,
        origin: { x: event.clientX, y: event.clientY },
        started: false,
        cleanup: () => {},
      };
      const move = (next: PointerEvent) => {
        if (gesture.current !== current || next.pointerId !== current.pointerId)
          return;
        const point = { x: next.clientX, y: next.clientY };
        if (!current.started) {
          if (
            Math.hypot(point.x - current.origin.x, point.y - current.origin.y) <
            DRAG_THRESHOLD
          )
            return;
          current.started = true;
          suppressed.current = true;
          callbacks.current.onStart?.(tool);
          if (gesture.current !== current) return;
        }
        next.preventDefault();
        setPreview({ tool, point });
        callbacks.current.onMove?.(tool, point);
      };
      const up = (next: PointerEvent) => {
        if (
          gesture.current !== current ||
          next.pointerId !== current.pointerId ||
          next.button !== 0
        )
          return;
        if (current.started) next.preventDefault();
        finish({ x: next.clientX, y: next.clientY });
      };
      const cancel = (next: PointerEvent) => {
        if (next.pointerId === current.pointerId) finish();
      };
      const escape = (next: KeyboardEvent) => {
        if (next.key !== "Escape" || gesture.current !== current) return;
        next.preventDefault();
        next.stopPropagation();
        finish();
      };
      const blur = (next: FocusEvent) => {
        if (next.target === next.currentTarget) finish();
      };
      current.cleanup = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("keydown", escape, true);
        window.removeEventListener("blur", blur, true);
      };
      gesture.current = current;
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("keydown", escape, true);
      window.addEventListener("blur", blur, true);
    },
    [clearSuppressionTimer, finish],
  );

  useEffect(() => {
    finish();
  }, [options.resetKey, finish]);
  useEffect(() => {
    if (options.disabled) finish();
  }, [options.disabled, finish]);
  useEffect(
    () => () => {
      finish(undefined, false);
      clearSuppressionTimer();
    },
    [clearSuppressionTimer, finish],
  );

  const suppressClick = useCallback(
    (event: {
      preventDefault: () => void;
      stopPropagation: () => void;
      detail?: number;
    }) => {
      // Keyboard activation must remain available even just after a drag.
      if (!suppressed.current || event.detail === 0) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    [],
  );

  return { begin, dragging: preview !== null, preview, suppressClick };
}
