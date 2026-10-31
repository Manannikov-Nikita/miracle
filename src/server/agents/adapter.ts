import { buildAgentCommand } from "./command.js";
import { startCodexTurn } from "./codex.js";
import { startClaudeTurn } from "./claude.js";
import { agentError, checkAgentCommand } from "./transport.js";

export type AdapterEvent =
  | { type: "message"; text: string }
  | { type: "action"; text: string; details?: Record<string, unknown> }
  | { type: "session"; sessionId: string }
  | {
      type: "approval";
      id: string;
      message: string;
      details?: Record<string, unknown>;
    }
  | { type: "notice"; text: string };
export interface AgentAdapterOptions {
  provider: "codex" | "claude";
  command: string;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  mcp: { url: string; token: string };
  onEvent: (event: AdapterEvent) => void;
}
export interface AgentProcess {
  completion: Promise<{ sessionId?: string }>;
  cancel: () => Promise<void>;
  respond: (id: string, decision: "allow" | "deny") => void;
}

export function previewAgentCommand(
  provider: "codex" | "claude",
  command: string,
): string {
  return buildAgentCommand(provider, command).preview;
}
export async function validateAgentCommand(
  provider: "codex" | "claude",
  command: string,
  cwd: string,
): Promise<{ version: string; commandPreview: string; executable: string }> {
  return checkAgentCommand(provider, command, cwd);
}
export function startAgentTurn(options: AgentAdapterOptions): AgentProcess {
  const controller = new AbortController();
  let active: AgentProcess | undefined;
  const completion = (async () => {
    await checkAgentCommand(
      options.provider,
      options.command,
      options.cwd,
      controller.signal,
    );
    if (controller.signal.aborted)
      throw agentError("Agent turn stopped", "AGENT_CANCELLED");
    active =
      options.provider === "codex"
        ? startCodexTurn(options)
        : startClaudeTurn(options);
    return await active.completion;
  })();
  return {
    completion,
    async cancel() {
      controller.abort();
      if (active) await active.cancel();
      await completion.catch(() => {});
    },
    respond(id, decision) {
      active?.respond(id, decision);
    },
  };
}
