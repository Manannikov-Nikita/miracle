import type { AgentMessage, AgentTurn } from "../../shared/agents";

export type ActivityKind =
  "read" | "search" | "edit" | "command" | "web" | "tool" | "plan" | "subagent";
export interface ActivityResource {
  id: string;
  label: string;
  href?: string;
}
export interface AgentActivityItem {
  id: string;
  label: string;
  events: AgentMessage[];
  state: "running" | "completed" | "failed" | "cancelled" | "unknown";
  kind: ActivityKind;
  description?: string;
  resources: ActivityResource[];
  durationMs?: number;
}

type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max = 240): string =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f]+/g, " ")
        .trim()
        .slice(0, max)
    : "";
const labels: Record<string, string> = {
  project_context: "Контекст проекта",
  begin_entity_work: "Начало работы с объектами",
  end_entity_work: "Завершение работы с объектами",
  list_connections: "Источники данных",
  read_schema: "Схема данных",
  list_editors: "Документы SQL",
  read_editor: "Чтение SQL",
  create_editor: "Создание SQL",
  edit_editor: "Изменение SQL",
  list_queries: "Сохранённые запросы",
  read_query: "Чтение запроса",
  save_query: "Сохранение запроса",
  run_query: "Запуск запроса",
  query_status: "Проверка запроса",
  cancel_query: "Остановка запроса",
  read_result: "Чтение результата",
  list_boards: "Список досок",
  read_board: "Чтение доски",
  create_board: "Создание доски",
  board_patch: "Изменение доски",
  refresh_node: "Запуск обновления результата",
  chart_guide: "Справка по графикам",
  custom_chart_guide: "Справка по кастомным графикам",
  read_custom_chart_status: "Проверка кастомного графика",
  permission_prompt: "Запрос разрешения",
  Read: "Чтение файла",
  Glob: "Поиск файлов",
  Grep: "Поиск в файлах",
  Edit: "Изменение файла",
  MultiEdit: "Изменение файлов",
  Write: "Запись файла",
  Bash: "Команда в терминале",
  WebSearch: "Поиск в интернете",
  WebFetch: "Чтение страницы",
  TodoWrite: "План работы",
};

function toolName(message: AgentMessage, details: Data) {
  return text(details.tool || details.name || message.content, 200).replace(
    /^mcp__miracle__/,
    "",
  );
}
function nativeMiracle(message: AgentMessage, details: Data) {
  return (
    details.source !== "miracle" &&
    (details.server === "miracle" || /^mcp__miracle__/.test(message.content))
  );
}
function classify(message: AgentMessage, details: Data): ActivityKind {
  const name = toolName(message, details);
  const input = record(details.input || details.arguments);
  if (details.subagent || details.type === "subAgentActivity")
    return "subagent";
  if (details.type === "plan" || name === "TodoWrite") return "plan";
  if (details.type === "webSearch" || ["WebSearch", "WebFetch"].includes(name))
    return "web";
  if (
    details.type === "fileChange" ||
    ["Edit", "MultiEdit", "Write"].includes(name)
  )
    return "edit";
  if (name === "Read") return "read";
  if (["Grep", "Glob"].includes(name)) return "search";
  if (details.type === "commandExecution") {
    const actions = list(details.commandActions).map(record);
    if (actions.length && actions.every((a) => a.type === "read"))
      return "read";
    if (
      actions.length &&
      actions.every((a) => ["search", "listFiles"].includes(String(a.type)))
    )
      return "search";
    return "command";
  }
  if (
    name === "Bash" ||
    typeof input.command === "string" ||
    /^\/.*(?:sh|bash|zsh)\s/.test(message.content)
  )
    return "command";
  return "tool";
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(token|access_token|api[_-]?key|password|secret|signature)$/i.test(
          key,
        ),
      )
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

function resources(details: Data): ActivityResource[] {
  const found = new Map<string, ActivityResource>();
  const add = (value: unknown, href?: unknown) => {
    const label = text(value, 160);
    if (!label || found.size >= 8) return;
    const url = href === undefined ? undefined : safeUrl(href);
    if (href !== undefined && !url) return;
    const id = url || label;
    found.set(id, { id, label, ...(url ? { href: url } : {}) });
  };
  const addUrl = (value: unknown) => {
    const url = safeUrl(value);
    if (url) add(new URL(url).hostname, url);
  };
  for (const value of list(details.resources)) {
    const item = record(value);
    add(item.label, item.href);
  }
  const input = record(details.input || details.arguments);
  for (const value of [input.file_path, input.path, details.path]) add(value);
  for (const value of list(details.changes)) add(record(value).path);
  for (const value of list(details.commandActions)) add(record(value).path);
  for (const value of [input.url, details.url, record(details.action).url])
    addUrl(value);
  // Only structured source URLs are promoted to links, never arbitrary output text.
  for (const value of [...list(details.sources), ...list(details.results)])
    addUrl(record(value).url);
  return [...found.values()];
}

function describe(message: AgentMessage, details: Data, kind: ActivityKind) {
  const name = toolName(message, details);
  const input = record(details.input || details.arguments);
  const child = record(details.subagent);
  let label = labels[name];
  if (kind === "subagent")
    label = text(child.name, 100)
      ? `Помощник · ${text(child.name, 100)}`
      : "Работа помощника";
  if (!label)
    label =
      {
        read: "Чтение файлов",
        search: "Поиск в проекте",
        edit: "Изменение файлов",
        command: "Команда в терминале",
        web: "Поиск в интернете",
        plan: "План работы",
        subagent: "Работа помощника",
        tool: "",
      }[kind] ||
      text(name, 120) ||
      "Действие агента";
  let description = text(details.summary);
  if (!description && kind === "subagent")
    description = text(child.task || child.message);
  if (!description && kind === "command")
    description = text(details.command || input.command || message.content);
  if (!description && kind === "search") {
    const action = list(details.commandActions)
      .map(record)
      .find((item) => item.query);
    description = text(input.pattern || input.query || action?.query);
  }
  if (!description && kind === "web")
    description = text(
      input.query || details.query || record(details.action).query,
    );
  if (!description && kind === "plan") {
    const plan = list(details.plan || input.todos).map(record);
    if (plan.length) {
      const completed = plan.filter(
        (step) => step.status === "completed",
      ).length;
      const current = plan.find((step) =>
        ["in_progress", "inProgress"].includes(String(step.status)),
      );
      description = `${completed} из ${plan.length} шагов${current ? ` · ${text(current.step || current.content, 160)}` : ""}`;
    } else description = text(details.explanation || details.text);
  }
  if (!description && kind === "edit" && list(details.changes).length)
    description = `Файлов: ${list(details.changes).length}`;
  if (kind === "command" && typeof details.exitCode === "number")
    description += `${description ? " · " : ""}Код выхода: ${details.exitCode}`;
  return {
    label,
    ...(description ? { description } : {}),
    resources: resources(details),
  };
}

function stateOf(details: Data): AgentActivityItem["state"] {
  const child = record(details.subagent);
  const status = child.status || details.status;
  if (
    details.error ||
    details.isError ||
    details.is_error ||
    details.success === false ||
    record(details.result).isError ||
    status === "failed" ||
    (typeof details.exitCode === "number" && details.exitCode !== 0)
  )
    return "failed";
  if (
    ["cancelled", "interrupted", "declined", "closed"].includes(String(status))
  )
    return "cancelled";
  if (status === "completed") return "completed";
  if (details.subagent) return status === "unknown" ? "unknown" : "running";
  if (Array.isArray(details.plan) && details.plan.length)
    return details.plan.every((step) => record(step).status === "completed")
      ? "completed"
      : "running";
  if (
    details.phase === "completed" ||
    (typeof details.tool === "string" && Object.keys(details).length === 1)
  )
    return "completed";
  return "running";
}

export function activityItems(
  messages: AgentMessage[],
  turn?: AgentTurn,
): AgentActivityItem[] {
  const groups = new Map<
    string,
    { item: AgentActivityItem; details: Data; message: AgentMessage }
  >();
  for (const message of messages) {
    if (message.role !== "action") continue;
    const details = message.details || {};
    const nativeId =
      record(details.subagent).id ??
      details.id ??
      details.toolUseId ??
      details.tool_use_id;
    const source = details.subagent
      ? "subagent"
      : details.source === "miracle"
        ? "miracle"
        : `native:${text(String(details.activityScope ?? "legacy"))}`;
    const id =
      typeof nativeId === "string" || typeof nativeId === "number"
        ? `${source}:${nativeId}`
        : `event:${message.id}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        item: {
          id,
          label: "",
          events: [],
          state: "running",
          kind: "tool",
          resources: [],
        },
        details: {},
        message,
      };
      groups.set(id, group);
    }
    group.details = {
      ...group.details,
      ...details,
      ...(details.subagent
        ? {
            subagent: {
              ...record(group.details.subagent),
              ...record(details.subagent),
            },
          }
        : {}),
    };
    group.message = message;
    group.item.events.push(message);
    group.item.kind = classify(message, group.details);
    Object.assign(
      group.item,
      describe(message, group.details, group.item.kind),
    );
    if (group.item.state !== "failed")
      group.item.state = stateOf(group.details);
    if (
      typeof group.details.durationMs === "number" &&
      Number.isFinite(group.details.durationMs) &&
      group.details.durationMs >= 0
    )
      group.item.durationMs = group.details.durationMs;
  }
  const authoritative = new Set(
    [...groups.values()]
      .filter((g) => g.details.source === "miracle")
      .map((g) => toolName(g.message, g.details)),
  );
  return [...groups.values()]
    .filter((group) => {
      // Successful native MCP items describe transport of the same server-owned
      // operation. Failed transport is retained: it may never reach the server.
      return !(
        nativeMiracle(group.message, group.details) &&
        group.item.state === "completed" &&
        authoritative.has(toolName(group.message, group.details))
      );
    })
    .map(({ item }) => {
      if (
        item.state === "running" &&
        turn &&
        !["running", "waiting"].includes(turn.status)
      ) {
        item.state = ["cancelled", "interrupted"].includes(turn.status)
          ? "cancelled"
          : "unknown";
      }
      return item;
    });
}
