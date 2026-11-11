import type { AgentContextUsage } from "../../shared/agent-context.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const tokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function contextWindow(value: unknown): number | undefined {
  return tokenCount(value) && value > 0 ? value : undefined;
}

export function contextModel(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;
}

export function codexContextUsage(
  value: unknown,
): AgentContextUsage | undefined {
  const usage = record(value);
  const usedTokens = record(usage?.last)?.totalTokens;
  if (!tokenCount(usedTokens)) return;
  const window = contextWindow(usage?.modelContextWindow);
  return {
    provider: "codex",
    usedTokens,
    ...(window !== undefined ? { contextWindow: window } : {}),
  };
}

export function claudeContextUsage(
  value: unknown,
  model?: string,
): AgentContextUsage | undefined {
  const usage = record(value);
  if (!usage || !tokenCount(usage.input_tokens)) return;
  const cacheCreation =
    usage.cache_creation_input_tokens === undefined
      ? 0
      : usage.cache_creation_input_tokens;
  const cacheRead =
    usage.cache_read_input_tokens === undefined
      ? 0
      : usage.cache_read_input_tokens;
  if (!tokenCount(cacheCreation) || !tokenCount(cacheRead)) return;
  const usedTokens = usage.input_tokens + cacheCreation + cacheRead;
  if (!tokenCount(usedTokens)) return;
  return { provider: "claude", usedTokens, ...(model ? { model } : {}) };
}

export function claudeContextWindow(
  value: unknown,
  model: string | undefined,
): number | undefined {
  const models = record(value);
  if (!model || !models || !Object.hasOwn(models, model)) return;
  return contextWindow(record(models[model])?.contextWindow);
}
