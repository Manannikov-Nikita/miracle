import { useEffect, useState } from "react";
import { HISTOGRAM_BIN_LIMIT } from "../../shared/chart-appearance";

export default function HistogramBinCount({
  value,
  disabled,
  onChange,
}: {
  value?: number;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const saved = String(value ?? "");
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const number = Number(draft);
  const valid =
    draft === "" ||
    (Number.isInteger(number) && number >= 1 && number <= HISTOGRAM_BIN_LIMIT);
  return (
    <label>
      Число интервалов
      <input
        type="number"
        min={1}
        max={HISTOGRAM_BIN_LIMIT}
        step={1}
        placeholder="Авто"
        value={draft}
        disabled={disabled}
        aria-invalid={!valid || undefined}
        onChange={(event) => {
          const field = event.currentTarget;
          setDraft(field.value);
          if (field.validity.valid) {
            const next = field.value === "" ? undefined : field.valueAsNumber;
            if (next !== value) onChange(next);
          }
        }}
        onBlur={() => setDraft(saved)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
