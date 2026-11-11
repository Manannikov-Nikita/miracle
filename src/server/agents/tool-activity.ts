export interface MiracleToolSummary {
  summary?: string;
  resources?: { id: string; label: string }[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown, limit = 120) => {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean
    ? clean.length <= limit
      ? clean
      : `${clean.slice(0, limit - 1)}…`
    : undefined;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resources(values: unknown[], fallback?: string) {
  const result: { id: string; label: string }[] = [];
  for (const value of values) {
    const item = record(value);
    const label = text(item?.name) || fallback;
    if (label && typeof item?.id === "string" && uuid.test(item.id))
      result.push({ id: item.id, label });
    if (result.length === 6) break;
  }
  return result.length ? { resources: result } : {};
}

const listLabels: Record<string, string> = {
  list_connections: "Найдено подключений",
  list_editors: "Найдено документов SQL",
  list_queries: "Найдено запросов",
  list_boards: "Найдено досок",
};
const documentTools = new Set([
  "read_editor",
  "create_editor",
  "edit_editor",
  "read_query",
  "save_query",
  "read_board",
  "create_board",
  "board_patch",
]);
const queryStatuses: Record<string, string> = {
  running: "выполняется",
  cancelling: "отменяется",
  paused: "на паузе",
  completed: "выполнен",
  failed: "ошибка",
  cancelled: "отменён",
};

/** Only deliberately selected public metadata reaches the activity journal. */
export function miracleToolSummary(
  name: string,
  value: unknown,
): MiracleToolSummary {
  const result = record(value);
  if (listLabels[name] && Array.isArray(value))
    return {
      summary: `${listLabels[name]}: ${value.length}`,
      ...resources(value),
    };
  if (documentTools.has(name)) {
    const title = text(result?.name);
    const revision =
      Number.isSafeInteger(result?.revision) && Number(result?.revision) >= 0
        ? `Версия ${result!.revision}`
        : undefined;
    return {
      summary:
        [title, revision].filter(Boolean).join(" · ") || "Документ получен",
      ...resources([value]),
    };
  }
  switch (name) {
    case "run_query":
    case "refresh_node":
      return { summary: "Запрос запущен", ...resources([value], "SQL-запрос") };
    case "query_status":
    case "cancel_query": {
      const status =
        typeof result?.status === "string"
          ? queryStatuses[result.status]
          : undefined;
      return {
        summary: status
          ? `Статус запроса: ${status}`
          : "Статус запроса получен",
        ...resources([value], "SQL-запрос"),
      };
    }
    case "read_result":
      return {
        ...(Array.isArray(result?.rows)
          ? { summary: `Получено строк: ${result.rows.length}` }
          : {}),
        ...resources([result?.result], "Результат запроса"),
      };
    case "read_schema":
      return Array.isArray(result?.items)
        ? { summary: `Получено объектов: ${result.items.length}` }
        : {};
    case "begin_entity_work":
      return { summary: "Объекты защищены от параллельных изменений" };
    case "end_entity_work":
      return { summary: "Работа с объектами завершена" };
    case "project_context":
      return { summary: "Контекст проекта получен" };
    case "chart_guide":
    case "custom_chart_guide":
      return { summary: "Справка получена" };
    case "read_custom_chart_status":
      return Array.isArray(result?.reports)
        ? { summary: `Получено наблюдений: ${result.reports.length}` }
        : {};
    default:
      return {};
  }
}

export function miracleToolFailure(error: unknown): string {
  // Never persist the service/validation message: it can contain SQL, tokens,
  // connection URLs or the values rejected by a schema.
  if (error instanceof Error && error.name === "ZodError")
    return "Некорректные параметры действия";
  const code = record(error)?.code;
  if (code === "REVISION_CONFLICT")
    return "Объект изменился; нужно прочитать его заново";
  if (code === "ENTITY_AGENT_LOCKED") return "Объект занят другой задачей";
  return "Не удалось выполнить действие";
}
