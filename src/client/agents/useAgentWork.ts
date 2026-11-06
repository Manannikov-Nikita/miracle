import { useSyncExternalStore } from "react";
import {
  agentWorkKey,
  type AgentEntityWork,
  type AgentWorkSnapshot,
  type AgentWorkTarget,
} from "../../shared/agent-work";
import { useProjectSync, type ProjectSync } from "./ProjectSync";

const empty: AgentWorkSnapshot = { revision: -1, locks: [] };
export const currentAgentWork = (project: ProjectSync | null | undefined) =>
  project?.workSnapshot?.().locks ?? empty.locks;
export function findAgentWork(
  locks: AgentEntityWork[],
  target?: AgentWorkTarget | null,
) {
  return target
    ? locks.find((work) => agentWorkKey(work.target) === agentWorkKey(target))
    : undefined;
}
export function editorAgentWork(
  locks: AgentEntityWork[],
  tab: { id: string; queryId?: string },
  filePath?: string,
) {
  return (
    findAgentWork(locks, { kind: "editor", id: tab.id }) ??
    (tab.queryId
      ? findAgentWork(locks, { kind: "query", id: tab.queryId })
      : undefined) ??
    (filePath
      ? findAgentWork(locks, { kind: "file", id: filePath })
      : undefined)
  );
}
export function useAgentWorkLocks(): AgentEntityWork[] {
  const project = useProjectSync();
  return useSyncExternalStore(
    (changed) => project?.subscribeWork?.(changed) ?? (() => {}),
    () => project?.workSnapshot?.() ?? empty,
    () => empty,
  ).locks;
}
export function useAgentWork(
  target?: AgentWorkTarget | null,
): AgentEntityWork | undefined {
  return findAgentWork(useAgentWorkLocks(), target);
}
