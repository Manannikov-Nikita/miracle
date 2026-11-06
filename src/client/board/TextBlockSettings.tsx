import { resolveTextStyle, type TextStyleSpec } from "../../shared/text-style";
import { TextSettings } from "./ShapeSettings";

export default function TextBlockSettings({
  text,
  textStyle,
  disabled,
  onChange,
}: {
  text: string;
  textStyle?: TextStyleSpec;
  disabled: boolean;
  onChange: (patch: { text?: string; textStyle?: TextStyleSpec }) => void;
}) {
  return (
    <div
      className="shape-settings text-block-settings nokey"
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <label>
        Текст
        <textarea
          aria-label="Текст блока"
          className="shape-text-editor"
          maxLength={200000}
          value={text}
          readOnly={disabled}
          placeholder="Введите текст…"
          onChange={(event) => {
            if (!disabled) onChange({ text: event.target.value });
          }}
        />
      </label>
      <TextSettings
        value={resolveTextStyle(textStyle)}
        disabled={disabled}
        update={(patch) => {
          if (!disabled) onChange({ textStyle: { ...textStyle, ...patch } });
        }}
      />
    </div>
  );
}
