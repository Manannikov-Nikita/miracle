import type { AgentContextSnapshot } from "../../shared/agent-context";

const categories = [
  ["conversation", "Переписка"],
  ["project", "Данные проекта"],
  ["tools", "Инструменты Miracle"],
  ["instructions", "Инструкции Miracle"],
] as const;

export interface ContextBreakdownRow {
  id: (typeof categories)[number][0] | "other";
  label: string;
  tokens: number | null;
  width: number;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Keep provider measurements intact; only the visible-content estimates shrink. */
export function contextBreakdown(usage?: AgentContextSnapshot | null) {
  const usedTokens = tokenCount(usage?.usedTokens);
  const reportedWindow = tokenCount(usage?.contextWindow);
  const contextWindow =
    reportedWindow && reportedWindow > 0 ? reportedWindow : null;
  const estimates = categories.map(
    ([id]) => tokenCount(usage?.estimates?.[id]) ?? 0,
  );
  const sum = estimates.reduce((total, count) => total + count, 0);
  if (usedTokens !== null && sum > usedTokens) {
    const scaled = estimates.map((count) => (count / sum) * usedTokens);
    const rounded = scaled.map(Math.floor);
    let remainder =
      usedTokens - rounded.reduce((total, count) => total + count, 0);
    const order = scaled
      .map((count, index) => ({ index, remainder: count - rounded[index] }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const { index } of order) {
      if (remainder <= 0) break;
      rounded[index]++;
      remainder--;
    }
    estimates.splice(0, estimates.length, ...rounded);
  }
  const rows: ContextBreakdownRow[] = categories.map(([id, label], index) => ({
    id,
    label,
    tokens: usedTokens === null ? null : estimates[index],
    width: 0,
  }));
  rows.push({
    id: "other",
    label: "Остальной контекст",
    tokens:
      usedTokens === null
        ? null
        : Math.max(
            0,
            usedTokens - estimates.reduce((total, count) => total + count, 0),
          ),
    width: 0,
  });
  if (usedTokens !== null && contextWindow !== null) {
    const geometryTotal = Math.max(contextWindow, usedTokens);
    for (const row of rows) row.width = (row.tokens! / geometryTotal) * 100;
  }
  return {
    usedTokens,
    contextWindow,
    percentage:
      usedTokens !== null && contextWindow !== null
        ? (usedTokens / contextWindow) * 100
        : null,
    availableTokens:
      usedTokens !== null && contextWindow !== null
        ? Math.max(0, contextWindow - usedTokens)
        : null,
    rows,
  };
}
