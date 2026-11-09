import { z } from "zod";
import type {
  AgentModelCatalog,
  AgentModelInfo,
  AgentModelSettings,
} from "../../shared/agents.js";
import { buildAgentCommand, childAgentEnvironment } from "./command.js";
import { AgentTransport, agentError, sanitizeAgentText } from "./transport.js";

const identifier = z.string().min(1).max(200);
const modelSchema = z.object({
  model: identifier,
  displayName: z.string().max(500).optional(),
  description: z.string().max(10000).optional(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  supportedReasoningEfforts: z
    .array(
      z.object({
        reasoningEffort: identifier,
        description: z.string().max(10000).optional(),
      }),
    )
    .max(100),
  defaultReasoningEffort: identifier.nullish(),
});
const pageSchema = z.object({
  data: z.array(modelSchema).max(2000),
  nextCursor: z.string().min(1).max(4096).nullish(),
});

/** The caller must verify local profile trust before executing its command. */
export async function discoverCodexModels(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentModelCatalog> {
  if (signal?.aborted) throw agentError("Запрос отменён", "AGENT_CANCELLED");
  const built = buildAgentCommand("codex", command);
  const env = childAgentEnvironment(process.env, built.env);
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        value && (/TOKEN|KEY|PASSWORD|SECRET/i.test(key) || value.length > 12),
    )
    .map(([, value]) => value!);
  for (const [index, arg] of built.args.entries()) {
    const equal = arg.indexOf("=");
    const key = equal >= 0 ? arg.slice(0, equal) : built.args[index - 1];
    if (!key || !/TOKEN|SECRET|PASSWORD|API.?KEY/i.test(key)) continue;
    const value = equal >= 0 ? arg.slice(equal + 1).trim() : arg;
    if (!value) continue;
    secrets.push(value);
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded === "string") secrets.push(decoded);
    } catch {
      if (value.startsWith("'") && value.endsWith("'"))
        secrets.push(value.slice(1, -1));
    }
  }
  const unavailable = (detail: string) =>
    Object.assign(
      agentError(
        "Не удалось получить модели Codex. Проверьте подключение и совместимость CLI в профиле. " +
          sanitizeAgentText(detail, secrets),
        "AGENT_MODELS_UNAVAILABLE",
      ),
      { statusCode: 503 },
    );
  const transport = new AgentTransport(built.executable, built.args, cwd, env);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let stopped = false;
  let failure: Error | undefined;
  let stderr = "";
  const fail = (error: Error) => {
    if (stopped || failure) return;
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const abort = () => fail(agentError("Запрос отменён", "AGENT_CANCELLED"));
  const timer = setTimeout(
    () => fail(unavailable("CLI не ответил за 8 секунд.")),
    8000,
  );
  signal?.addEventListener("abort", abort, { once: true });
  transport.child.stderr.setEncoding("utf8");
  transport.child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  transport.json(
    (message) => {
      if (
        stopped ||
        failure ||
        message.method ||
        typeof message.id !== "number"
      )
        return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error)
        request.reject(
          unavailable(
            String(message.error.message || "Ошибка протокола model/list."),
          ),
        );
      else request.resolve(message.result);
    },
    (error) => fail(unavailable(error.message)),
  );
  void transport.closed.then((result) =>
    fail(
      unavailable(
        result.error
          ? `Не удалось запустить CLI: ${result.error.message}`
          : `CLI завершился до получения списка моделей (${result.code ?? result.signal}). ${stderr}`,
      ),
    ),
  );
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (signal?.aborted) abort();
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      transport.send({ id, method, params });
    });
  };
  try {
    const initialized = await request("initialize", {
      clientInfo: { name: "miracle", title: "Miracle", version: "0.2.1" },
      capabilities: { experimentalApi: false },
    });
    if (
      !initialized ||
      typeof initialized !== "object" ||
      !("userAgent" in initialized) ||
      typeof initialized.userAgent !== "string"
    )
      throw unavailable("CLI вернул несовместимый ответ initialize.");
    transport.send({ method: "initialized", params: {} });
    const configuration = await request("config/read", {
      includeLayers: false,
      cwd,
    });
    const parsedConfig = z
      .object({
        config: z.object({
          model: identifier.nullish(),
          model_reasoning_effort: identifier.nullish(),
        }),
      })
      .safeParse(configuration);
    if (!parsedConfig.success)
      throw unavailable("CLI вернул несовместимый ответ config/read.");
    const models: AgentModelInfo[] = [];
    const modelIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let catalogDefault: string | undefined;
    let received = 0;
    for (let page = 0; page < 20; page++) {
      const response = await request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      const parsed = pageSchema.safeParse(response);
      if (!parsed.success)
        throw unavailable("CLI вернул несовместимый ответ model/list.");
      received += parsed.data.data.length;
      if (received > 2000)
        throw unavailable("Список моделей превышает допустимый размер.");
      for (const item of parsed.data.data) {
        if (item.hidden || modelIds.has(item.model)) continue;
        modelIds.add(item.model);
        if (item.isDefault && !catalogDefault) catalogDefault = item.model;
        models.push({
          id: item.model,
          name: item.displayName || item.model,
          ...(item.description ? { description: item.description } : {}),
          reasoningEfforts: item.supportedReasoningEfforts.map((effort) => ({
            id: effort.reasoningEffort,
            ...(effort.description ? { description: effort.description } : {}),
          })),
          ...(item.defaultReasoningEffort
            ? { defaultReasoningEffort: item.defaultReasoningEffort }
            : {}),
        });
      }
      const next = parsed.data.nextCursor;
      if (!next) {
        if (!models.length)
          throw unavailable("CLI не сообщил доступные модели.");
        const defaultModel = parsedConfig.data.config.model ?? catalogDefault;
        const defaultReasoningEffort =
          parsedConfig.data.config.model_reasoning_effort ??
          models.find((model) => model.id === defaultModel)
            ?.defaultReasoningEffort;
        return {
          models,
          ...(defaultModel ? { defaultModel } : {}),
          ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        };
      }
      if (cursors.has(next))
        throw unavailable("CLI повторил страницу списка моделей.");
      cursors.add(next);
      cursor = next;
    }
    throw unavailable("Список моделей превышает допустимое число страниц.");
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await transport.stop();
  }
}

/** Resolve explicit values so a resumed native thread cannot retain an old override. */
export function resolveCodexModelSettings(
  catalog: AgentModelCatalog,
  settings: AgentModelSettings,
): AgentModelSettings {
  const id = settings.model ?? catalog.defaultModel;
  const model = catalog.models.find((item) => item.id === id);
  if (!model)
    throw Object.assign(
      agentError(
        settings.model
          ? "Выбранная модель Codex больше недоступна. Обновите список моделей."
          : "Не удалось определить модель профиля Codex. Выберите модель явно.",
        "AGENT_MODEL_UNAVAILABLE",
      ),
      { statusCode: 400 },
    );
  // Models with no reasoning controls must not inherit a profile's effort.
  if (!model.reasoningEfforts.length && settings.reasoningEffort === undefined)
    return { model: model.id };
  const reasoningEffort =
    settings.reasoningEffort ??
    (!settings.model || settings.model === catalog.defaultModel
      ? (catalog.defaultReasoningEffort ?? model.defaultReasoningEffort)
      : model.defaultReasoningEffort);
  if (!reasoningEffort)
    throw Object.assign(
      agentError(
        "Codex не сообщил уровень reasoning по умолчанию. Выберите уровень явно или обновите CLI.",
        "AGENT_REASONING_UNSUPPORTED",
      ),
      { statusCode: 400 },
    );
  if (!model.reasoningEfforts.some((effort) => effort.id === reasoningEffort))
    throw Object.assign(
      agentError(
        "Выбранный уровень reasoning недоступен для этой модели Codex. Выберите уровень из списка модели.",
        "AGENT_REASONING_UNSUPPORTED",
      ),
      { statusCode: 400 },
    );
  return { model: model.id, reasoningEffort };
}
