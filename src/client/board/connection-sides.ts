import type { BoardHandleSide } from "../../shared/types";

export const boardHandleOptions: { value: BoardHandleSide; label: string }[] = [
  { value: "top", label: "Сверху" },
  { value: "right", label: "Справа" },
  { value: "bottom", label: "Снизу" },
  { value: "left", label: "Слева" },
];

export function boardHandleSide(
  value: unknown,
  fallback: BoardHandleSide,
): BoardHandleSide {
  return (
    boardHandleOptions.find((option) => option.value === value)?.value ??
    fallback
  );
}
