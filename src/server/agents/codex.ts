import type { AgentAdapterOptions, AgentProcess } from "./adapter.js";
import { buildAgentCommand, childAgentEnvironment } from "./command.js";
import {
  AgentTransport,
  agentError,
  sanitizeAgentText,
  sanitizeAgentValue,
} from "./transport.js";

export function startCodexTurn(options: AgentAdapterOptions): AgentProcess {
  const command = buildAgentCommand("codex", options.command);
  const args = [
    ...command.args,
    "-c",
    `mcp_servers.miracle.url=${JSON.stringify(options.mcp.url)}`,
    "-c",
    'mcp_servers.miracle.bearer_token_env_var="MIRACLE_AGENT_MCP_TOKEN"',
    "-c",
    "mcp_servers.miracle.required=true",
  ];
  const env = {
    ...childAgentEnvironment(process.env, command.env),
    MIRACLE_AGENT_MCP_TOKEN: options.mcp.token,
  };
  const transport = new AgentTransport(
    command.executable,
    args,
    options.cwd,
    env,
  );
  const secretValues = [
    options.mcp.token,
    ...Object.entries(command.env)
      .filter(([key]) => /TOKEN|KEY|PASSWORD|SECRET/i.test(key))
      .map(([, value]) => value),
  ];
  const clean = (s: string) => sanitizeAgentText(s, secretValues);
  const emit = (event: Parameters<AgentAdapterOptions["onEvent"]>[0]) =>
    options.onEvent(sanitizeAgentValue(event, secretValues));
  let settled = false,
    cancelled = false,
    sessionId: string | undefined,
    turnId: string | undefined,
    nextId = 1,
    stderr = "";
  let startingTurn = false;
  const earlyNotifications: { method: string; params: any }[] = [];
  const streamed = new Set<string>();
  const approvals = new Map<
    string,
    { id: string | number; method: string; params: any }
  >();
  const pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let finish!: (error?: Error) => void;
  const completion = new Promise<{ sessionId?: string }>((resolve, reject) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      const failure = cancelled
        ? agentError("Agent turn stopped", "AGENT_CANCELLED")
        : error;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(failure || agentError("Agent turn ended"));
      }
      pending.clear();
      approvals.clear();
      void transport
        .stop()
        .then(
          () => (failure ? reject(failure) : resolve({ sessionId })),
          reject,
        );
    };
  });
  function request(method: string, params: unknown): Promise<any> {
    if (settled)
      return Promise.reject(agentError("Agent process has already ended"));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(agentError(`Codex ${method} request timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      transport.send({ id, method, params });
    });
  }
  transport.child.stderr.setEncoding("utf8");
  transport.child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  transport.json((message) => {
    if (settled) return;
    if (message.id !== undefined && !message.method) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error)
        p.reject(
          agentError(
            clean(String(message.error.message || "Codex request failed")),
          ),
        );
      else p.resolve(message.result);
      return;
    }
    const params = message.params || {};
    if (message.id !== undefined && message.method) {
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
          "execCommandApproval",
          "applyPatchApproval",
        ].includes(message.method)
      ) {
        const id = String(message.id);
        approvals.set(id, { id: message.id, method: message.method, params });
        emit({
          type: "approval",
          id,
          message: clean(
            params.reason || params.command || "Codex requests permission",
          ),
          details: { method: message.method, ...params },
        });
      } else {
        transport.send({
          id: message.id,
          error: {
            code: -32601,
            message:
              "Miracle supports allow/deny approvals only; this client request is unsupported",
          },
        });
        emit({
          type: "notice",
          text: `Codex requested an unsupported client interaction: ${message.method}`,
        });
      }
      return;
    }
    handleNotification(message.method, params);
  }, finish);
  function handleNotification(method: string, params: any) {
    // App Server also broadcasts child-agent threads. Only the turn returned
    // by our own turn/start request owns this process's text and completion.
    if (settled || !sessionId || params.threadId !== sessionId) return;
    if (!turnId) {
      if (startingTurn) earlyNotifications.push({ method, params });
      return;
    }
    if ((params.turnId ?? params.turn?.id) !== turnId) return;
    if (
      method === "item/agentMessage/delta" &&
      typeof params.delta === "string"
    ) {
      streamed.add(params.itemId);
      emit({ type: "message", text: params.delta });
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      params.item
    ) {
      const item = params.item;
      if (
        item.type === "agentMessage" &&
        method === "item/completed" &&
        !streamed.has(item.id) &&
        typeof item.text === "string"
      )
        emit({ type: "message", text: item.text });
      else if (
        !["agentMessage", "userMessage", "reasoning"].includes(item.type)
      )
        emit({
          type: "action",
          text: String(item.command || item.tool || item.query || item.type),
          details: { ...item, phase: method.split("/")[1] },
        });
    }
    if (method === "error" && params.willRetry !== true)
      finish(agentError(clean(params.error?.message || "Codex turn failed")));
    if (method === "turn/completed") {
      const turn = params.turn;
      if (turn?.status === "failed")
        finish(agentError(clean(turn.error?.message || "Codex turn failed")));
      else if (turn?.status === "interrupted")
        finish(agentError("Agent turn stopped", "AGENT_CANCELLED"));
      else if (turn?.status === "completed") finish();
      else
        finish(
          agentError("Codex returned an unrecognized turn completion status"),
        );
    }
  }
  void transport.closed.then((result) => {
    if (!settled)
      finish(
        agentError(
          clean(
            result.error
              ? `Unable to launch Codex: ${result.error.message}`
              : `Codex exited before completing the turn (${result.code ?? result.signal}): ${stderr}`,
          ),
        ),
      );
  });
  void (async () => {
    try {
      const init = await request("initialize", {
        clientInfo: { name: "miracle", title: "Miracle", version: "0.2.1" },
        capabilities: { experimentalApi: false },
      });
      if (!init || typeof init.userAgent !== "string")
        throw agentError(
          "Codex app-server initialization did not return a compatible protocol response",
        );
      transport.send({ method: "initialized", params: {} });
      let thread;
      try {
        thread = await request(
          options.resumeSessionId ? "thread/resume" : "thread/start",
          {
            ...(options.resumeSessionId
              ? { threadId: options.resumeSessionId }
              : {}),
            cwd: options.cwd,
          },
        );
      } catch (error: any) {
        if (
          options.resumeSessionId &&
          /(thread|session|rollout).*(not found|does not exist)|no (rollout|thread|session).*found/i.test(
            error.message,
          )
        )
          throw agentError(
            "The saved Codex session is unavailable",
            "AGENT_SESSION_UNAVAILABLE",
          );
        throw error;
      }
      sessionId = thread?.thread?.id;
      if (!sessionId) throw agentError("Codex did not return a thread ID");
      emit({ type: "session", sessionId });
      startingTurn = true;
      const turn = await request("turn/start", {
        threadId: sessionId,
        cwd: options.cwd,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
      });
      turnId = turn?.turn?.id;
      if (!turnId && !settled)
        throw agentError("Codex did not return a turn ID");
      startingTurn = false;
      for (const notification of earlyNotifications.splice(0))
        handleNotification(notification.method, notification.params);
    } catch (error: any) {
      finish(
        error instanceof Error
          ? error
          : agentError("Codex protocol initialization failed"),
      );
    }
  })();
  return {
    completion,
    respond(id, decision) {
      const approval = approvals.get(id);
      if (!approval || settled) return;
      approvals.delete(id);
      const result =
        approval.method === "item/permissions/requestApproval"
          ? {
              permissions:
                decision === "allow"
                  ? Object.fromEntries(
                      Object.entries(approval.params.permissions || {}).filter(
                        ([, value]) => value !== null,
                      ),
                    )
                  : {},
              scope: "turn",
            }
          : {
              decision:
                approval.method === "execCommandApproval" ||
                approval.method === "applyPatchApproval"
                  ? decision === "allow"
                    ? "approved"
                    : "denied"
                  : decision === "allow"
                    ? "accept"
                    : "decline",
            };
      transport.send({ id: approval.id, result });
    },
    async cancel() {
      if (settled) {
        await transport.stop();
        return;
      }
      cancelled = true;
      if (sessionId && turnId) {
        transport.send({
          id: nextId++,
          method: "turn/interrupt",
          params: { threadId: sessionId, turnId },
        });
        await Promise.race([
          completion.catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      finish(agentError("Agent turn stopped", "AGENT_CANCELLED"));
      await transport.stop();
    },
  };
}
