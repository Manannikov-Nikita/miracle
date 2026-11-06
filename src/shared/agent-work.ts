export type AgentWorkTarget =
  | { kind: "editor" | "query" | "file" | "board"; id: string }
  | {
      kind: "board-node" | "board-edge" | "board-slide";
      boardId: string;
      id: string;
    };

export interface AgentEntityWork {
  target: AgentWorkTarget;
  turnId: string;
  chatId: string;
  startedAt: string;
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
