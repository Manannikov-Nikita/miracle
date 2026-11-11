import type {
  AgentContextSnapshot,
  AgentContextUsage,
} from "../../shared/agent-context.js";

const projectMarker = "\nProject context (data):\n";
// Approximation only: one token per four JavaScript string characters, rounded
// up. These are visible payload estimates, not tokenizer or native CLI counts.
const estimate = (text: string) => Math.ceil(text.length / 4);

export function contextSnapshot(
  usage: AgentContextUsage,
  sources: { prompt: string; conversation: string; tools: string },
  measuredAt: string,
): AgentContextSnapshot | undefined {
  if (!Number.isSafeInteger(usage.usedTokens) || usage.usedTokens < 0)
    return undefined;
  const projectStart = sources.prompt.indexOf(projectMarker);
  const dataStart = projectStart + projectMarker.length;
  const dataEnd = sources.prompt.indexOf("\n", dataStart);
  return {
    provider: usage.provider,
    usedTokens: usage.usedTokens,
    ...(Number.isSafeInteger(usage.contextWindow) && usage.contextWindow! > 0
      ? { contextWindow: usage.contextWindow }
      : {}),
    ...(usage.model ? { model: usage.model } : {}),
    measuredAt,
    estimates: {
      conversation: estimate(sources.conversation),
      project:
        projectStart < 0
          ? 0
          : estimate(
              sources.prompt.slice(
                dataStart,
                dataEnd < 0 ? undefined : dataEnd,
              ),
            ),
      tools: estimate(sources.tools),
      instructions:
        projectStart < 0 ? 0 : estimate(sources.prompt.slice(0, projectStart)),
    },
  };
}
