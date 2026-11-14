export type AgentWorkTarget =
  | { kind: "editor" | "query" | "file" | "board"; id: string }
  | {
      kind: "board-node" | "board-edge" | "board-slide";
      boardId: string;
      id: string;
    };

export interface AgentWorkWorker {
  id: string;
  name: string;
  color: number;
}

const workerColors = [
  "#a855f7",
  "#0891b2",
  "#d97706",
  "#db2777",
  "#16a34a",
  "#3b82f6",
  "#e04d23",
  "#818cf8",
  "#22998b",
  "#ba8e14",
  "#9f4e8c",
  "#567b2e",
  "#d34b5d",
  "#5464b7",
  "#9e673f",
  "#2783c4",
] as const;

export function agentWorkColor(index: number): string | undefined {
  return Number.isInteger(index) && index >= 0
    ? workerColors[index]
    : undefined;
}

export interface AgentEntityWork {
  target: AgentWorkTarget;
  turnId: string;
  chatId: string;
  startedAt: string;
  worker?: AgentWorkWorker;
}

export interface AgentWorkSnapshot {
  revision: number;
  locks: AgentEntityWork[];
}

export function agentWorkKey(target: AgentWorkTarget): string {
  return JSON.stringify([
    target.kind,
    "boardId" in target ? target.boardId : "",
    target.id,
  ]);
}
