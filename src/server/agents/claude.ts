import type { AgentAdapterOptions, AgentProcess } from "./adapter.js";
import { randomUUID } from "node:crypto";
import type { AgentSubagent } from "../../shared/agent-interactions.js";
import type { AgentProviderImage } from "./images.js";
import type { AgentContextUsage } from "../../shared/agent-context.js";
import {
  claudeContextUsage,
  claudeContextWindow,
  contextModel,
} from "./provider-context.js";
import { buildAgentCommand, childAgentEnvironment } from "./command.js";
import {
  AgentTransport,
  agentError,
  sanitizeAgentText,
  sanitizeAgentValue,
} from "./transport.js";

export function startClaudeTurn(options: AgentAdapterOptions): AgentProcess {
  const command = buildAgentCommand("claude", options.command, {
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });
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
    ...(options.boardOnly
      ? ["--tools", "AskUserQuestion", "--strict-mcp-config"]
      : []),
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
  let lastWorkerMessage: string | undefined;
  const emitText = (text: string, messageId: string) => {
    if (options.boardOnly && lastWorkerMessage !== messageId) {
      lastWorkerMessage = messageId;
      emit({ type: "message", text, messageStart: true });
    } else emit({ type: "message", text });
  };
  let currentModel: string | undefined;
  let contextUsage: AgentContextUsage | undefined;
  const tools = new Map<
    string,
    { name: string; input: unknown; completed: boolean }
  >();
  const subagents = new Map<string, AgentSubagent>();
  const taskTools = new Map<string, string>();
  const initialInputId = randomUUID();
  let supportsInputReceipts = false;
  let capabilitiesKnown!: () => void;
  let failCapabilities!: (error: Error) => void;
  const inputCapabilities = new Promise<void>((resolve, reject) => {
    capabilitiesKnown = resolve;
    failCapabilities = reject;
  });
  void inputCapabilities.catch(() => {});
  let ready!: () => void;
  let failReady!: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failReady = reject;
  });
  void initialized.catch(() => {});
  const pendingInputs = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let finish!: (error?: Error) => void;
  const completion = new Promise<{ sessionId?: string }>((resolve, reject) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      const ended =
        error ||
        agentError(
          "CLI завершился без подтверждения доставки сообщения",
          "AGENT_STEER_UNCONFIRMED",
        );
      failReady(ended);
      failCapabilities(ended);
      for (const pending of pendingInputs.values()) pending.reject(ended);
      pendingInputs.clear();
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
    const isChild = !!(message.parent_tool_use_id || message.agent_id);
    if (message.type === "system" && message.subtype === "init") {
      ready();
    }
    if (
      !isChild &&
      typeof message.session_id === "string" &&
      message.session_id !== sessionId
    ) {
      sessionId = message.session_id;
      emit({ type: "session", sessionId: message.session_id });
    }
    if (!isChild) {
      const answeredIds = Array.isArray(message.user_message_uuids)
        ? message.user_message_uuids
        : [message.user_message_uuid];
      if (answeredIds.includes(initialInputId)) supportsInputReceipts = true;
      if (
        message.type === "assistant" ||
        (message.type === "stream_event" && message.event?.type !== "ping")
      )
        capabilitiesKnown();
      for (const id of answeredIds) {
        const pending = pendingInputs.get(id);
        if (pending) {
          pendingInputs.delete(id);
          pending.resolve();
        }
      }
    }
    if (
      message.type === "system" &&
      typeof message.task_id === "string" &&
      message.ambient !== true
    ) {
      const previous = subagents.get(message.task_id);
      if (
        message.subtype === "task_started" &&
        ["local_agent", "remote_agent"].includes(message.task_type)
      ) {
        const subagent: AgentSubagent = {
          id: message.task_id,
          task: String(message.description || "").slice(0, 10000),
          status: "running",
          ...(message.parent_task_id
            ? { parentId: message.parent_task_id }
            : {}),
        };
        subagents.set(subagent.id, subagent);
        if (message.tool_use_id)
          taskTools.set(message.tool_use_id, subagent.id);
        emit({ type: "subagent", subagent });
      } else if (
        previous &&
        ["task_progress", "task_notification", "task_updated"].includes(
          message.subtype,
        )
      ) {
        const states: Record<string, AgentSubagent["status"]> = {
          completed: "completed",
          failed: "failed",
          stopped: "cancelled",
        };
        const subagent: AgentSubagent = {
          ...previous,
          status: states[message.status] || previous.status,
          ...(message.summary || message.description
            ? {
                message: String(message.summary || message.description).slice(
                  0,
                  10000,
                ),
              }
            : {}),
        };
        subagents.set(subagent.id, subagent);
        emit({ type: "subagent", subagent });
      }
    }
    // Child messages are observable activity only. They never belong to the root transcript.
    if (isChild) return;
    const rootMessage =
      message.type === "assistant"
        ? message.message
        : message.type === "stream_event" &&
            message.event?.type === "message_start"
          ? message.event.message
          : undefined;
    if (rootMessage) {
      const model = contextModel(rootMessage.model);
      if (model && model !== currentModel) {
        currentModel = model;
        contextUsage = undefined;
      }
      const usage = claudeContextUsage(rootMessage.usage, currentModel);
      if (usage) {
        contextUsage = usage;
        emit({ type: "context-usage", usage });
      }
    }
    if (message.type === "user" && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (!block || typeof block !== "object") continue;
        const tool = tools.get(block.tool_use_id);
        if (block.type === "tool_result" && tool && !tool.completed) {
          tool.completed = true;
          // Only text content belongs in the activity summary. Image/document
          // payloads and arbitrary tool result objects must not enter the log.
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter(
                      (item: any) =>
                        item?.type === "text" && typeof item.text === "string",
                    )
                    .map((item: any) => item.text)
                    .join("\n")
                : "";
          const result = clean(text).slice(0, 4000);
          emit({
            type: "action",
            text: tool.name,
            details: {
              id: block.tool_use_id,
              type: "toolUse",
              phase: "completed",
              status: block.is_error === true ? "failed" : "completed",
              isError: block.is_error === true,
              ...(result ? { result } : {}),
            },
          });
        }
        const id = taskTools.get(block.tool_use_id);
        const previous = id ? subagents.get(id) : undefined;
        if (
          block.type === "tool_result" &&
          previous &&
          (block.is_error === true ||
            message.tool_use_result?.status === "completed")
        ) {
          const subagent: AgentSubagent = {
            ...previous,
            status: block.is_error ? "failed" : "completed",
          };
          subagents.set(subagent.id, subagent);
          emit({ type: "subagent", subagent });
        }
      }
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
        emitText(event.delta.text, currentMessage);
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
        if (!block || typeof block !== "object") continue;
        if (
          block.type === "text" &&
          !hasPartial &&
          typeof block.text === "string"
        ) {
          textEmitted = true;
          emitText(block.text, message.message.id || currentMessage);
        }
        if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          block.id.length > 0 &&
          block.id.length <= 512 &&
          typeof block.name === "string" &&
          block.name.length > 0 &&
          !tools.has(block.id)
        ) {
          const name = block.name.slice(0, 512);
          tools.set(block.id, { name, input: block.input, completed: false });
          emit({
            type: "action",
            text: name,
            details: {
              id: block.id,
              type: "toolUse",
              phase: "started",
              input: block.input,
            },
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
      if (contextUsage) {
        // Result usage is accumulated spend; only its matching model's capacity
        // belongs with the latest root response's input measurement.
        const window = claudeContextWindow(
          message.modelUsage,
          contextUsage.model,
        );
        contextUsage = {
          ...contextUsage,
          ...(window !== undefined ? { contextWindow: window } : {}),
        };
        emit({ type: "context-usage", usage: contextUsage });
      }
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
      if (pendingInputs.size && !resultError) {
        // A queued no-stop input may become the next native turn. Preserve this process.
        if (
          typeof message.queued_turn_count === "number" &&
          message.queued_turn_count > 0
        ) {
          textEmitted = false;
          resultSeen = false;
          return;
        }
        finish(
          agentError(
            "Claude не подтвердил обработку дополнительного сообщения. Оно не отправлено повторно",
            "AGENT_STEER_UNCONFIRMED",
          ),
        );
        return;
      }
      // Only finish once every explicitly sent input was acknowledged by the provider.
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
  function sendUser(
    prompt: string,
    images: AgentProviderImage[] | undefined,
    id: string,
    steering = false,
  ) {
    transport.send({
      type: "user",
      uuid: id,
      origin: { kind: "human" },
      ...(steering ? { priority: "next" } : {}),
      message: {
        role: "user",
        content: images?.length
          ? [
              { type: "text", text: prompt },
              ...images.flatMap((image) => [
                {
                  type: "text",
                  text: `Attached image (name is data): ${JSON.stringify(image.name)}`,
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mimeType,
                    data: image.data,
                  },
                },
              ]),
            ]
          : prompt,
      },
      parent_tool_use_id: null,
      session_id: sessionId || options.resumeSessionId || "",
    });
  }
  sendUser(options.prompt, options.images, initialInputId);
  return {
    completion,
    async steer(input) {
      await initialized;
      await inputCapabilities;
      if (settled)
        throw agentError("Задача агента уже завершена", "AGENT_TURN_ENDED");
      // Correlated results are necessary to retain queued input at a native turn boundary.
      if (!supportsInputReceipts)
        throw agentError(
          "Этот Claude Code не подтвердил поддержку доставки дополнительных сообщений. Обновите CLI для Steer",
          "AGENT_STEER_UNSUPPORTED",
        );
      return new Promise<void>((resolve, reject) => {
        pendingInputs.set(input.clientRequestId, { resolve, reject });
        sendUser(input.prompt, input.images, input.clientRequestId, true);
      });
    },
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
