import type { AgentMessage } from "../../shared/agents";
import { agentWorkColor } from "../../shared/agent-work";
import {
  codexActivitySubagent,
  type AgentSubagent,
} from "../../shared/agent-interactions";

export const activeSubagentStatuses = new Set<AgentSubagent["status"]>([
  "pending",
  "running",
  "waiting",
]);
const statuses = new Set([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "closed",
  "unknown",
]);
type ActivitySubagent = AgentSubagent & { color?: string };

/** Provider snapshots can update status alone; retain the last known task/name. */
export function agentSubagents(
  messages: AgentMessage[],
  turnId: string | null,
): ActivitySubagent[] {
  const children = new Map<string, ActivitySubagent>();
  if (!turnId) return [];
  for (const message of messages) {
    if (message.turnId !== turnId || message.role !== "action") continue;
    const childId = message.details?.agentThreadId;
    const raw: unknown =
      message.details?.subagent ||
      codexActivitySubagent(
        message.details,
        typeof childId === "string" ? children.get(childId)?.status : undefined,
      );
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      !value.id.trim() ||
      typeof value.status !== "string" ||
      !statuses.has(value.status)
    )
      continue;
    const previous = children.get(value.id);
    const child: ActivitySubagent = {
      ...previous,
      id: value.id,
      status: value.status as AgentSubagent["status"],
    };
    for (const field of ["name", "task", "parentId", "message"] as const) {
      if (typeof value[field] === "string") child[field] = value[field];
    }
    const worker = message.details?.worker;
    if (
      worker &&
      typeof worker === "object" &&
      "id" in worker &&
      worker.id === child.id &&
      "color" in worker &&
      typeof worker.color === "number"
    ) {
      child.color = agentWorkColor(worker.color) ?? child.color;
    }
    children.set(child.id, child);
  }
  return [...children.values()];
}
