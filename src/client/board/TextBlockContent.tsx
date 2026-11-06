import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import { resolveTextStyle, type TextStyleSpec } from "../../shared/text-style";
import "./text-block.css";

const fontFamilies = {
  sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
};
const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

export default function TextBlockContent({
  text,
  textStyle,
  editable,
  onChange,
}: {
  text: string;
  textStyle?: TextStyleSpec;
  editable: boolean;
  onChange: (text: string) => void;
}) {
  const spec = resolveTextStyle(textStyle);
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
  }, [isEditing, text, spec.fontSize, spec.fontFamily, spec.bold, spec.italic]);

  const appearance: CSSProperties = {
    color: textStyle?.textColor ?? "var(--board-text)",
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

  return (
    <div
      className={`board-text-content${isEditing ? " board-text-editing" : ""}`}
      style={appearance}
      onDoubleClick={(event) => {
        if (!editable) return;
        event.stopPropagation();
        setEditing(true);
      }}
    >
      {isEditing ? (
        <textarea
          ref={editor}
          className="board-text-editor nodrag nopan nowheel nokey"
          aria-label="Текст блока"
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
        <div className="board-text-value">{text}</div>
      )}
    </div>
  );
}
