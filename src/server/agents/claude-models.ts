import { randomUUID } from "node:crypto";
import type {
  AgentModelCatalog,
  AgentModelInfo,
  AgentModelSettings,
} from "../../shared/agents.js";
import { buildAgentCommand, childAgentEnvironment } from "./command.js";
import { AgentTransport, agentError } from "./transport.js";

const catalogError = (message: string) =>
  Object.assign(agentError(message, "AGENT_MODEL_CATALOG_UNAVAILABLE"), {
    statusCode: 400,
  });
const selectionError = (message: string) =>
  Object.assign(agentError(message, "AGENT_MODEL_SETTINGS_INVALID"), {
    statusCode: 400,
  });
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  !value.startsWith("-") &&
  !/[\x00-\x1f\x7f]/.test(value);
const label = (value: unknown, maximum: number) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;

/** Claude has no documented effective-settings read API: validate only explicit overrides. */
export function resolveClaudeModelSettings(
  catalog: AgentModelCatalog,
  settings: AgentModelSettings = {},
): AgentModelSettings {
  const model = catalog.models.find(
    (item) => item.id === (settings.model ?? catalog.defaultModel),
  );
  if (settings.model !== undefined && !model)
    throw selectionError(
      "Выбранная модель Claude недоступна. Обновите список моделей.",
    );
  if (settings.reasoningEffort !== undefined && !model)
    throw selectionError(
      "Сначала выберите модель Claude: уровень рассуждений по умолчанию не удалось определить.",
    );
  if (
    settings.reasoningEffort !== undefined &&
    !model!.reasoningEfforts.some(
      (item) => item.id === settings.reasoningEffort,
    )
  )
    throw selectionError(
      "Этот уровень рассуждений недоступен для выбранной модели Claude.",
    );
  return {
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.reasoningEffort !== undefined
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
  };
}

/** Initialize the local CLI's control protocol without sending a user/model turn. */
export async function discoverClaudeModels(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentModelCatalog> {
  if (signal?.aborted)
    throw agentError("Получение моделей отменено", "AGENT_CANCELLED");
  const built = buildAgentCommand("claude", command);
  const providerArgs = built.args.slice(built.prefixArgs.length);
  if (
    providerArgs.some(
      (arg) => arg === "--settings" || arg.startsWith("--settings="),
    )
  )
    throw catalogError(
      "Не удалось безопасно получить модели для профиля с --settings: проверка отключает стартовые hooks и не заменяет ваши настройки. Для выбора модели используйте отдельный профиль без --settings; текущая команда остаётся доступной.",
    );
  const env = childAgentEnvironment(process.env, built.env);
  const args = built.args.filter(
    (_arg, index) =>
      built.args[index] !== "--permission-prompt-tool" &&
      built.args[index - 1] !== "--permission-prompt-tool",
  );
  args.push(
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    '{"disableAllHooks":true}',
    "--no-session-persistence",
  );
  const profileFlag = (name: string) => {
    let value: string | undefined;
    for (let index = 0; index < providerArgs.length; index++) {
      const arg = providerArgs[index];
      if (arg === name) value = providerArgs[++index];
      else if (arg.startsWith(name + "=")) value = arg.slice(name.length + 1);
    }
    return value;
  };
  const configuredModel = profileFlag("--model") ?? env.ANTHROPIC_MODEL;
  const configuredEffort =
    profileFlag("--effort") ?? env.CLAUDE_CODE_EFFORT_LEVEL;
  const transport = new AgentTransport(
    built.executable,
    args,
    cwd,
    env,
    1024 * 1024,
  );
  // Consume stderr without returning provider settings, account details or credentials.
  transport.child.stderr.resume();
  const requestId = randomUUID();
  let settled = false;
  let finish!: (error?: Error, catalog?: AgentModelCatalog) => void;
  const result = new Promise<AgentModelCatalog>((resolve, reject) => {
    finish = (error, catalog) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(catalog!);
    };
  });
  const abort = () =>
    finish(agentError("Получение моделей отменено", "AGENT_CANCELLED"));
  const timeout = setTimeout(
    () =>
      finish(
        catalogError(
          "Claude не ответил при получении моделей. Проверьте CLI и авторизацию в профиле.",
        ),
      ),
    8000,
  );
  signal?.addEventListener("abort", abort, { once: true });
  transport.json(
    (message) => {
      if (
        settled ||
        message.type !== "control_response" ||
        message.response?.request_id !== requestId
      )
        return;
      const response = message.response;
      if (
        response.subtype !== "success" ||
        !Array.isArray(response.response?.models)
      ) {
        finish(
          catalogError(
            "Этот Claude CLI не предоставил список моделей. Обновите CLI или проверьте команду запуска профиля.",
          ),
        );
        return;
      }
      const models: AgentModelInfo[] = [];
      const aliases = new Map<string, string>();
      const seen = new Set<string>();
      for (const raw of response.response.models.slice(0, 256)) {
        if (
          !raw ||
          typeof raw !== "object" ||
          !identifier(raw.value) ||
          seen.has(raw.value)
        )
          continue;
        seen.add(raw.value);
        const efforts =
          raw.supportsEffort !== false &&
          Array.isArray(raw.supportedEffortLevels)
            ? ([
                ...new Set(
                  raw.supportedEffortLevels.filter((value: unknown) =>
                    identifier(value),
                  ),
                ),
              ].slice(0, 16) as string[])
            : [];
        models.push({
          id: raw.value,
          name: label(raw.displayName, 200) ?? raw.value,
          ...(label(raw.description, 2000)
            ? { description: label(raw.description, 2000) }
            : {}),
          reasoningEfforts: efforts.map((id) => ({ id })),
        });
        if (identifier(raw.resolvedModel))
          aliases.set(raw.resolvedModel, raw.value);
      }
      if (!models.length) {
        finish(
          catalogError(
            "Claude не сообщил доступные модели. Проверьте авторизацию и ограничения установленного CLI.",
          ),
        );
        return;
      }
      const defaultModel =
        configuredModel &&
        (seen.has(configuredModel)
          ? configuredModel
          : aliases.get(configuredModel));
      const current = models.find((item) => item.id === defaultModel);
      const defaultReasoningEffort =
        configuredEffort &&
        current?.reasoningEfforts.some((item) => item.id === configuredEffort)
          ? configuredEffort
          : undefined;
      finish(undefined, {
        models,
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      });
    },
    () =>
      finish(
        catalogError(
          "Claude вернул несовместимый ответ списка моделей. Проверьте версию CLI и команду профиля.",
        ),
      ),
  );
  void transport.closed.then((closed) =>
    finish(
      catalogError(
        closed.error
          ? "Не удалось запустить Claude CLI. Проверьте путь команды в профиле."
          : "Claude завершился до получения списка моделей. Проверьте CLI и авторизацию.",
      ),
    ),
  );
  try {
    if (signal?.aborted) abort();
    else
      transport.send({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize", hooks: null },
      });
    return await result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await transport.stop();
  }
}
