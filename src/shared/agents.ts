import type { DateRangeOptions } from "./date-batch.js";
import type { AgentContextSnapshot } from "./agent-context.js";
import type {
  AgentQuestionRequest,
  AgentSubagent,
} from "./agent-interactions.js";

export type AgentProvider = "codex" | "claude";
export const AGENT_IMAGE_MAX_COUNT = 4;
export const AGENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const AGENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type AgentImageMimeType = (typeof AGENT_IMAGE_MIME_TYPES)[number];
export interface AgentImageInput {
  name: string;
  mimeType: AgentImageMimeType;
  dataUrl: string;
}
export interface AgentImageAttachment {
  id: string;
  name: string;
  mimeType: AgentImageMimeType;
  size: number;
  url: string;
}
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
export interface AgentModelSettings {
  model?: string;
  reasoningEffort?: string;
}
export interface AgentModelInfo {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts: { id: string; name?: string; description?: string }[];
  defaultReasoningEffort?: string;
}
export interface AgentModelCatalog {
  models: AgentModelInfo[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
}
export interface AgentChat {
  id: string;
  title: string;
  profileId: string;
  provider: AgentProvider;
  autoApprove?: boolean;
  modelSettings?: AgentModelSettings;
  createdAt: string;
  updatedAt: string;
}
export type AgentTurnStatus =
  "running" | "waiting" | "completed" | "cancelled" | "failed" | "interrupted";
export interface AgentTargetContext {
  editorDocumentId?: string;
  boardId?: string;
  slideId?: string;
  selection?: string;
  filePaths?: string[];
  boardNodes?: { id: string; title: string }[];
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
  role: "user" | "assistant" | "action" | "system" | "approval" | "question";
  content: string;
  details?: Record<string, unknown> & {
    question?: AgentQuestionRequest;
    subagent?: AgentSubagent;
    contextUsage?: AgentContextSnapshot | null;
  };
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
