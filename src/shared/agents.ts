import type { DateRangeOptions } from "./date-batch.js";

export type AgentProvider = "codex" | "claude";
export interface ProjectContext {
  workspaceId: string;
  instanceId: string;
  projectRoot: string;
  dataDir: string;
}
export interface AgentProfile {
  id: string;
  name: string;
  provider: AgentProvider;
  command: string;
  trusted: boolean;
  createdAt: string;
}
export interface AgentChat {
  id: string;
  title: string;
  profileId: string;
  provider: AgentProvider;
  createdAt: string;
  updatedAt: string;
}
export type AgentTurnStatus =
  "running" | "waiting" | "completed" | "cancelled" | "failed" | "interrupted";
export interface AgentTargetContext {
  editorDocumentId?: string;
  boardId?: string;
  selection?: string;
}
export interface AgentTurn {
  id: string;
  chatId: string;
  status: AgentTurnStatus;
  context: AgentTargetContext;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}
export interface AgentMessage {
  id: string;
  chatId: string;
  turnId?: string;
  role: "user" | "assistant" | "action" | "system" | "approval";
  content: string;
  details?: Record<string, unknown>;
  createdAt: string;
}
export interface AgentConversation {
  chat: AgentChat;
  messages: AgentMessage[];
  turns: AgentTurn[];
}
export interface ProjectEvent {
  id: number;
  type: string;
  entityId?: string;
  data: unknown;
}
export interface EditorDocument {
  id: string;
  name: string;
  sql: string;
  connectionId: string;
  database?: string;
  catalog?: string;
  schema?: string;
  queryId?: string;
  queryRevision?: number;
  resultSetId?: string;
  runId?: string;
  dateRange?: DateRangeOptions;
  revision: number;
  updatedAt: string;
}
