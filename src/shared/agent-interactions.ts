export interface AgentQuestionOption {
  label: string;
  description?: string;
}
export interface AgentQuestion {
  id: string;
  header: string;
  question: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  isSecret?: boolean;
}
export interface AgentQuestionRequest {
  id: string;
  questions: AgentQuestion[];
  status: "pending" | "answered" | "cancelled";
  answers?: Record<string, string[]>;
}
export interface AgentSubagent {
  id: string;
  name?: string;
  task?: string;
  status:
    | "pending"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled"
    | "closed"
    | "unknown";
  parentId?: string;
  message?: string;
}

/** Codex 0.167+ emits lifecycle items; item completion is not child completion. */
export function codexActivitySubagent(
  raw: unknown,
  previousStatus?: AgentSubagent["status"],
): AgentSubagent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    value.type !== "subAgentActivity" ||
    typeof value.agentThreadId !== "string" ||
    !value.agentThreadId.trim()
  )
    return null;
  const status: AgentSubagent["status"] =
    value.kind === "started"
      ? "running"
      : value.kind === "completed"
        ? previousStatus &&
          ["failed", "cancelled", "closed"].includes(previousStatus)
          ? previousStatus
          : "completed"
        : value.kind === "interrupted"
          ? "cancelled"
          : value.kind === "interacted"
            ? previousStatus || "unknown"
            : "unknown";
  const name =
    typeof value.agentPath === "string"
      ? value.agentPath.split("/").filter(Boolean).at(-1)
      : undefined;
  return { id: value.agentThreadId, status, ...(name ? { name } : {}) };
}
