/** A single root-model context measurement, never cumulative session spend. */
export interface AgentContextUsage {
  provider: "codex" | "claude";
  usedTokens: number;
  contextWindow?: number;
  model?: string;
}

export interface AgentContextEstimates {
  conversation: number;
  project: number;
  tools: number;
  instructions: number;
}

export interface AgentContextSnapshot extends AgentContextUsage {
  measuredAt: string;
  estimates: AgentContextEstimates;
}

export interface AgentContextUpdate {
  chatId: string;
  messageId: string;
  contextUsage: AgentContextSnapshot | null;
}
