import { useLayoutEffect, useRef, useState } from "react";

const placeholder = "Запишите наблюдение…";
const minFontSize = 14;
const maxFontSize = 56;

/** Measure in layout pixels so fitting stays independent of the board's zoom. */
export default function StickyNoteEditor({
  value,
  readOnly,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ fontSize: maxFontSize, height: 68 });

  useLayoutEffect(() => {
    const container = host.current;
    const mirror = measure.current;
    if (!container || !mirror) return;
    let frame = 0;
    let disposed = false;
    const fit = () => {
      const width = container.clientWidth - 40;
      const height = container.clientHeight - 40;
      if (width <= 0 || height <= 0) return;
      mirror.style.width = `${width}px`;
      const measureHeight = (size: number) => {
        mirror.style.fontSize = `${size}px`;
        return mirror.scrollHeight;
      };
      let low = minFontSize;
      let high = maxFontSize;
      while (low < high) {
        const size = Math.ceil((low + high) / 2);
        if (measureHeight(size) <= height) low = size;
        else high = size - 1;
      }
      const next = {
        fontSize: low,
        height: Math.min(height, measureHeight(low) + 2),
      };
      setLayout((previous) =>
        previous.fontSize === next.fontSize && previous.height === next.height
          ? previous
          : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    fit();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    void document.fonts?.ready.then(() => {
      if (!disposed) schedule();
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [value]);

  return (
    <div className="board-sticky-editor" ref={host}>
      <div className="board-note-measure" ref={measure} aria-hidden="true">
        {(value || placeholder) + "\u200b"}
      </div>
      <textarea
        maxLength={200000}
        aria-label="Текст заметки"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="board-note-text nokey"
        style={{ fontSize: layout.fontSize, height: layout.height }}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      />
    </div>
  );
}
