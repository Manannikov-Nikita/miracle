import { useEffect, useRef } from "react";
import { ReactFlow, type ReactFlowProps } from "@xyflow/react";
import type { BoardFlowEdge } from "./BoardEdgeView";
import type { BoardCanvasNode } from "./edge-flow";

export default function BoardFlow({
  gestureScope,
  ...props
}: ReactFlowProps<BoardCanvasNode, BoardFlowEdge> & { gestureScope: string }) {
  const host = useRef<HTMLDivElement>(null);
  const boardWheel = useRef(false);

  useEffect(() => {
    boardWheel.current = false;
    const element = host.current;
    if (!element) return;
    const reset = () => {
      boardWheel.current = false;
    };
    const continueBoardGesture = (event: WheelEvent) => {
      if (!boardWheel.current || !(event.target instanceof Element)) return;
      if (!event.target.closest(".nowheel")) return;
      const pane = element.querySelector(".react-flow__pane");
      if (!pane) return;

      // Keep the gesture with the board when moving content passes under the
      // pointer. XYFlow still owns speed, pinch zoom and its wheel-idle timeout.
      event.preventDefault();
      event.stopPropagation();
      pane.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        }),
      );
    };
    element.addEventListener("wheel", continueBoardGesture, {
      capture: true,
      passive: false,
    });
    element.addEventListener("pointerdown", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      reset();
      element.removeEventListener("wheel", continueBoardGesture, true);
      element.removeEventListener("pointerdown", reset, true);
      window.removeEventListener("blur", reset);
    };
  }, [gestureScope]);

  return (
    <ReactFlow<BoardCanvasNode, BoardFlowEdge>
      {...props}
      ref={host}
      onMoveStart={(event, viewport) => {
        boardWheel.current = event?.type === "wheel";
        props.onMoveStart?.(event, viewport);
      }}
      onMove={(event, viewport) => {
        if (event?.type === "wheel") boardWheel.current = true;
        props.onMove?.(event, viewport);
      }}
      onMoveEnd={(event, viewport) => {
        boardWheel.current = false;
        props.onMoveEnd?.(event, viewport);
      }}
    />
  );
}
