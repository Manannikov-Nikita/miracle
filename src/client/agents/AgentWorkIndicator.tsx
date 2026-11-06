import { Sparkle } from "@phosphor-icons/react";
import type { AgentEntityWork } from "../../shared/agent-work";

export function AgentWorkIndicator({
  work,
  compact = false,
}: {
  work?: AgentEntityWork;
  compact?: boolean;
}) {
  if (!work) return null;
  return (
    <span
      className={`agent-work-indicator${compact ? " compact" : ""}`}
      role="status"
      title="Агент работает"
    >
      <Sparkle size={14} weight="fill" aria-hidden="true" />
      <span className={compact ? "sr-only" : undefined}>Агент работает</span>
    </span>
  );
}
