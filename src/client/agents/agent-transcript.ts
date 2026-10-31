import type { AgentMessage, AgentTurn } from "../../shared/agents";

export interface TranscriptTurn {
  id: string;
  turn?: AgentTurn;
  messages: AgentMessage[];
}
export interface AgentActivityItem {
  id: string;
  label: string;
  events: AgentMessage[];
  state: "running" | "completed" | "failed" | "cancelled";
}

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

const toolLabels: Record<string, string> = {
  project_context: "Контекст проекта",
  list_connections: "Источники данных",
  read_schema: "Схема данных",
  list_editors: "Документы SQL",
  read_editor: "Чтение SQL",
  create_editor: "Создание SQL",
  edit_editor: "Изменение SQL",
  list_queries: "Сохранённые запросы",
  read_query: "Чтение запроса",
  save_query: "Сохранение запроса",
  run_query: "Выполнение запроса",
  query_status: "Проверка запроса",
  cancel_query: "Остановка запроса",
  read_result: "Чтение результата",
  list_boards: "Список досок",
  read_board: "Чтение доски",
  create_board: "Создание доски",
  board_patch: "Изменение доски",
  refresh_node: "Обновление результата",
  fileChange: "Изменение файлов",
  subAgentActivity: "Работа помощника",
  wait: "Ожидание помощника",
};
function activityLabel(message: AgentMessage): string {
  if (toolLabels[message.content]) return toolLabels[message.content];
  const type = message.details?.type;
  if (
    type === "commandExecution" ||
    /^\/.*(?:sh|bash|zsh)\s/.test(message.content)
  )
    return "Команда в терминале";
  if (typeof type === "string" && toolLabels[type]) return toolLabels[type];
  return message.content;
}

export function activityItems(
  messages: AgentMessage[],
  turn?: AgentTurn,
): AgentActivityItem[] {
  const groups = new Map<string, AgentActivityItem>();
  for (const message of messages) {
    if (message.role !== "action") continue;
    const details = message.details;
    const nativeId = details?.id ?? details?.toolUseId ?? details?.tool_use_id;
    // Without a native ID, retain separate events: identical arguments can be used by distinct calls.
    const id =
      typeof nativeId === "string" || typeof nativeId === "number"
        ? `call:${nativeId}`
        : `event:${message.id}`;
    let item = groups.get(id);
    if (!item) {
      item = {
        id,
        label: activityLabel(message),
        events: [],
        state: "running",
      };
      groups.set(id, item);
    }
    item.events.push(message);
    if (details?.error || details?.isError || details?.status === "failed")
      item.state = "failed";
    else if (
      details?.phase === "completed" ||
      details?.status === "completed" ||
      // Miracle emits this receipt only after its operation has succeeded.
      (typeof details?.tool === "string" && Object.keys(details).length === 1)
    ) {
      if (item.state !== "failed") item.state = "completed";
    }
  }
  for (const item of groups.values()) {
    if (item.state !== "running") continue;
    if (turn?.status === "completed") item.state = "completed";
    if (turn?.status === "failed") item.state = "failed";
    if (turn?.status === "cancelled" || turn?.status === "interrupted")
      item.state = "cancelled";
  }
  return [...groups.values()];
}

export function activityCount(count: number): string {
  const last = count % 10,
    tens = count % 100;
  return `${count} ${last === 1 && tens !== 11 ? "действие" : last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? "действия" : "действий"}`;
}
