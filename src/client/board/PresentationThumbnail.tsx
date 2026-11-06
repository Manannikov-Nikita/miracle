import { useLayoutEffect, useRef, useState } from "react";
import type { BoardDocument, PresentationSlide } from "../../shared/types";
import { PRESENTATION_WIDTH } from "../../shared/presentation";
import PresentationScene from "./PresentationScene";

export default function PresentationThumbnail({
  boardId,
  document,
  slide,
  visible,
}: {
  boardId: string;
  document: BoardDocument;
  slide: PresentationSlide;
  visible: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!visible || !element) return;
    const measure = () => setScale(element.clientWidth / PRESENTATION_WIDTH);
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [visible]);

  // The scene may contain form controls. Keep it outside the slide button.
  return (
    <div
      ref={frame}
      className="presentation-thumbnail-frame"
      inert
      aria-hidden="true"
      style={{ backgroundColor: slide.background }}
    >
      {visible && scale > 0 && (
        <PresentationScene
          boardId={boardId}
          document={document}
          slide={slide}
          scale={scale}
        />
      )}
    </div>
  );
}
