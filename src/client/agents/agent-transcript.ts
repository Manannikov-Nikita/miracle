import type { AgentMessage, AgentTurn } from "../../shared/agents";

export interface TranscriptTurn {
  id: string;
  turn?: AgentTurn;
  messages: AgentMessage[];
}
export { activityItems } from "./agent-activity-model";
export type { AgentActivityItem } from "./agent-activity-model";

export function transcriptTurns(
  messages: AgentMessage[],
  turns: AgentTurn[],
  active: AgentTurn | null,
): TranscriptTurn[] {
  const metadata = new Map(turns.map((turn) => [turn.id, turn]));
  if (active) metadata.set(active.id, active);
  const groups = new Map<string, TranscriptTurn>();
  for (const message of messages) {
    const id = message.turnId || `message:${message.id}`;
    if (!groups.has(id))
      groups.set(id, { id, turn: metadata.get(id), messages: [] });
    groups.get(id)!.messages.push(message);
  }
  if (active && !groups.has(active.id))
    groups.set(active.id, { id: active.id, turn: active, messages: [] });
  return [...groups.values()];
}

export function activityCount(count: number): string {
  const last = count % 10,
    tens = count % 100;
  return `${count} ${last === 1 && tens !== 11 ? "действие" : last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? "действия" : "действий"}`;
}
