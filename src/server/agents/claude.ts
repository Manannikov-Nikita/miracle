import type { AgentAdapterOptions, AgentProcess } from "./adapter.js";
import { buildAgentCommand, childAgentEnvironment } from "./command.js";
import {
  AgentTransport,
  agentError,
  sanitizeAgentText,
  sanitizeAgentValue,
} from "./transport.js";

export function startClaudeTurn(options: AgentAdapterOptions): AgentProcess {
  const command = buildAgentCommand("claude", options.command);
  const mcp = JSON.stringify({
    mcpServers: {
      miracle: {
        type: "http",
        url: options.mcp.url,
        headers: { Authorization: "Bearer ${MIRACLE_AGENT_MCP_TOKEN}" },
      },
    },
  });
  const args = [
    ...command.args,
    "--mcp-config",
    mcp,
    ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
  ];
  const transport = new AgentTransport(command.executable, args, options.cwd, {
    ...childAgentEnvironment(process.env, command.env),
    MIRACLE_AGENT_MCP_TOKEN: options.mcp.token,
  });
  const secrets = [
    options.mcp.token,
    ...Object.entries(command.env)
      .filter(([key]) => /TOKEN|KEY|PASSWORD|SECRET/i.test(key))
      .map(([, value]) => value),
  ];
  const clean = (s: string) => sanitizeAgentText(s, secrets);
  const emit = (event: Parameters<AgentAdapterOptions["onEvent"]>[0]) =>
    options.onEvent(sanitizeAgentValue(event, secrets));
  let textEmitted = false;
  let sessionId: string | undefined,
    settled = false,
    cancelled = false,
    stderr = "",
    resultSeen = false,
    resultError: Error | undefined;
  const partialMessages = new Set<string>();
  let currentMessage = "initial";
  const tools = new Set<string>();
  let finish!: (error?: Error) => void;
  const completion = new Promise<{ sessionId?: string }>((resolve, reject) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      void transport
        .stop(cancelled ? "SIGINT" : "SIGTERM")
        .then(() => (error ? reject(error) : resolve({ sessionId })), reject);
    };
  });
  function providerError(text: string) {
    const unavailable =
      options.resumeSessionId &&
      /no (conversation|session) found|(?:session|conversation).*(?:not found|does not exist)/i.test(
        text,
      );
    return agentError(
      unavailable ? "The saved Claude session is unavailable" : clean(text),
      unavailable ? "AGENT_SESSION_UNAVAILABLE" : undefined,
    );
  }
  transport.child.stderr.setEncoding("utf8");
  transport.child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  transport.json((message) => {
    if (settled) return;
    if (
      typeof message.session_id === "string" &&
      message.session_id !== sessionId
    ) {
      sessionId = message.session_id;
      emit({ type: "session", sessionId: message.session_id });
    }
    if (message.type === "stream_event") {
      const event = message.event;
      if (event?.type === "message_start")
        currentMessage = event.message?.id || currentMessage;
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        partialMessages.add(currentMessage);
        textEmitted = true;
        emit({ type: "message", text: event.delta.text });
      }
    }
    if (
      message.type === "assistant" &&
      Array.isArray(message.message?.content)
    ) {
      const hasPartial = partialMessages.has(
        message.message.id || currentMessage,
      );
      for (const block of message.message.content) {
        if (
          block.type === "text" &&
          !hasPartial &&
          typeof block.text === "string"
        ) {
          textEmitted = true;
          emit({ type: "message", text: block.text });
        }
        if (block.type === "tool_use" && !tools.has(block.id)) {
          tools.add(block.id);
          emit({
            type: "action",
            text: String(block.name),
            details: { id: block.id, input: block.input },
          });
        }
      }
    }
    if (
      message.type === "system" &&
      ["error", "warning", "permission_denied"].includes(message.subtype)
    )
      emit({
        type: "notice",
        text: clean(
          String(message.message || message.error || message.subtype),
        ),
      });
    if (message.type === "result") {
      resultSeen = true;
      if (
        !textEmitted &&
        !message.is_error &&
        typeof message.result === "string"
      )
        emit({ type: "message", text: message.result });
      if (message.is_error || message.subtype !== "success")
        resultError = providerError(
          (
            message.errors || [
              message.result || `Claude ended with ${message.subtype}`,
            ]
          ).join("\n"),
        );
      // A result is the one-turn boundary; do not wait for background provider work.
      finish(resultError);
    }
  }, finish);
  void transport.closed.then((result) => {
    if (settled) return;
    if (cancelled) finish(agentError("Agent turn stopped", "AGENT_CANCELLED"));
    else if (result.error)
      finish(
        agentError(clean(`Unable to launch Claude: ${result.error.message}`)),
      );
    else if (result.code !== 0)
      finish(
        providerError(
          stderr || `Claude exited with ${result.code ?? result.signal}`,
        ),
      );
    else if (!resultSeen)
      finish(agentError("Claude exited without a structured turn result"));
    else finish(resultError);
  });
  // Keep the bidirectional stream alive while the turn or a permission callback is pending.
  // The structured result is the one-turn boundary; finish owns closing the process.
  transport.send({
    type: "user",
    message: { role: "user", content: options.prompt },
    parent_tool_use_id: null,
    session_id: options.resumeSessionId || "",
  });
  return {
    completion,
    respond() {
      /* Claude permission callbacks are resolved by Miracle's MCP endpoint. */
    },
    async cancel() {
      if (settled) {
        await transport.stop();
        return;
      }
      cancelled = true;
      finish(agentError("Agent turn stopped", "AGENT_CANCELLED"));
      await transport.stop("SIGINT");
    },
  };
}
