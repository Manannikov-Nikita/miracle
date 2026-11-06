import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, ArrowRight, X } from "@phosphor-icons/react";
import type { Board } from "../../shared/types";
import {
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
} from "../../shared/presentation";
import PresentationScene from "./PresentationScene";
import { fitPresentationSlide } from "./presentation-model";

const noop = () => {};

export default function PresentationShow({
  board,
  initialSlideId,
  onClose,
  trigger,
}: {
  board: Board;
  initialSlideId: string;
  onClose(): void;
  trigger: HTMLElement;
}) {
  const [slideId, setSlideId] = useState(initialSlideId);
  const slides = board.document.slides ?? [];
  const index = Math.max(
    0,
    slides.findIndex((slide) => slide.id === slideId),
  );
  const slide = slides[index];
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const fullscreen = useRef(false);
  useEffect(() => {
    const target = content;
    if (!target) return;
    let live = true;
    const onFullscreenChange = () => {
      if (document.fullscreenElement === target) fullscreen.current = true;
      else if (fullscreen.current) onClose();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    void target
      .requestFullscreen?.()
      .then(() => {
        if (!live && document.fullscreenElement === target)
          void document.exitFullscreen?.().catch(noop);
      })
      .catch(noop);
    return () => {
      live = false;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement === target)
        void document.exitFullscreen?.().catch(noop);
    };
  }, [content, onClose]);
  useLayoutEffect(() => {
    const target = stage;
    if (!target) return;
    const resize = () =>
      setScale(
        fitPresentationSlide(target.clientWidth, target.clientHeight, 0).zoom,
      );
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(target);
    return () => observer.disconnect();
  }, [stage]);
  if (!slide) return null;
  const go = (index: number) =>
    setSlideId(slides[Math.min(slides.length - 1, Math.max(0, index))].id);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          ref={setContent}
          className="board-workspace presentation-show"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (trigger.isConnected) {
              event.preventDefault();
              trigger.focus({ preventScroll: true });
            }
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (
              event.key === "ArrowRight" ||
              event.key === "ArrowDown" ||
              event.key === "PageDown"
            )
              go(index + 1);
            else if (
              event.key === "ArrowLeft" ||
              event.key === "ArrowUp" ||
              event.key === "PageUp"
            )
              go(index - 1);
            else if (event.key === "Home") go(0);
            else if (event.key === "End") go(slides.length - 1);
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <Dialog.Title className="presentation-show-title">
            {board.name}
          </Dialog.Title>
          <div className="presentation-show-stage" ref={setStage}>
            <div
              className="presentation-show-frame"
              style={{
                width: PRESENTATION_WIDTH * scale,
                height: PRESENTATION_HEIGHT * scale,
              }}
            >
              <div
                className="presentation-show-scene"
                inert
                style={{ background: slide.background }}
              >
                <PresentationScene
                  document={board.document}
                  boardId={board.id}
                  slide={slide}
                  scale={scale}
                />
              </div>
            </div>
          </div>
          <footer className="presentation-show-controls">
            <button
              aria-label="Предыдущий слайд"
              onClick={() => go(index - 1)}
              disabled={index === 0}
            >
              <ArrowLeft size={17} />
            </button>
            <span aria-live="polite">
              {index + 1} / {slides.length} · {slide.title}
            </span>
            <button
              aria-label="Следующий слайд"
              onClick={() => go(index + 1)}
              disabled={index === slides.length - 1}
            >
              <ArrowRight size={17} />
            </button>
            <button aria-label="Закрыть показ" onClick={onClose}>
              <X size={17} />
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
