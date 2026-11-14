import { Sparkle } from "@phosphor-icons/react";
import { agentWorkColor, type AgentEntityWork } from "../../shared/agent-work";

export function AgentWorkIndicator({
  work,
  compact = false,
}: {
  work?: AgentEntityWork;
  compact?: boolean;
}) {
  if (!work) return null;
  const worker = work.worker;
  const label = worker ? `Работает: ${worker.name}` : "Агент работает";
  const color = worker ? agentWorkColor(worker.color) : undefined;
  return (
    <span
      className={`agent-work-indicator${compact ? " compact" : ""}${worker ? " agent-worker" : ""}`}
      role="status"
      title={label}
    >
      <Sparkle size={14} weight="fill" color={color} aria-hidden="true" />
      <span className={compact ? "sr-only" : "agent-work-name"}>
        {worker ? (
          <>
            <span className="sr-only">Работает: </span>
            {worker.name}
          </>
        ) : (
          label
        )}
      </span>
    </span>
  );
}
