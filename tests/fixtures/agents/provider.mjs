import { appendFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const args = process.argv.slice(2),
  mode = process.env.FIXTURE_PROVIDER;
const write = (stream, chunk) =>
  new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
const trace = (data) => {
  if (process.env.FIXTURE_TRACE)
    appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(data) + "\n");
};
if (args.includes("--version")) {
  await write(
    process.stdout,
    (mode === "claude" ? "2.1.200 (Claude Code)" : "codex-cli 0.136.0") + "\n",
  );
  process.exit(0);
}
if (args.includes("--help") && process.env.FIXTURE_SCENARIO === "old-cli") {
  await write(process.stdout, "old CLI without structured protocol\n");
  process.exit(0);
}
if (args.includes("--help")) {
  await write(
    process.stdout,
    (mode === "claude"
      ? "--input-format --output-format --verbose --include-partial-messages --permission-prompt-tool --mcp-config --resume"
      : "--stdio --listen app-server") + "\n",
  );
  process.exit(0);
}
trace({
  args,
  pid: process.pid,
  cwd: process.cwd(),
  control: process.env.MIRACLE_CONTROL_TOKEN,
  token: !!process.env.MIRACLE_AGENT_MCP_TOKEN,
});
const configError = () =>
  `failed to load configuration: config.toml:3:26: unknown variant ultra; token=${process.env.TEST_API_TOKEN}; config=${args.find((arg) => arg.startsWith("provider.api_key=")) || "unset"}`;
if (process.env.FIXTURE_SCENARIO === "config-exit-error") {
  await write(process.stderr, configError());
  process.exit(1);
}
let initialUserId;
let chain = Promise.resolve();
const emit = (value) => {
  // All v2 turn/item notifications carry their owning thread and turn.
  if (
    mode === "codex" &&
    value.method &&
    value.id === undefined &&
    /^(turn\/|item\/|error$)/.test(value.method)
  ) {
    value.params = {
      threadId: "codex-session",
      ...(!value.method.startsWith("turn/") ? { turnId: "turn-1" } : {}),
      ...value.params,
    };
  }
  const b = Buffer.from(JSON.stringify(value) + "\n");
  chain = chain.then(async () => {
    const pivot = Math.max(1, b.indexOf(Buffer.from("🌍")) + 2);
    await write(process.stdout, b.subarray(0, pivot));
    await new Promise((r) => setTimeout(r, 3));
    await write(process.stdout, b.subarray(pivot));
  });
  return chain;
};
const rl = createInterface({ input: process.stdin });
function hang() {
  if (process.env.FIXTURE_SCENARIO === "stubborn") {
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)",
      ],
      { stdio: "ignore" },
    );
    trace({ childPid: child.pid, pid: process.pid });
  }
  setInterval(() => {}, 1000);
}
rl.on("close", () => trace({ inputEnded: true }));
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  trace({ wire: m });
  if (mode === "claude") {
    if (m.type !== "user" || m.message?.role !== "user") process.exit(10);
    if (process.env.FIXTURE_SCENARIO.startsWith("steer")) {
      if (!initialUserId) {
        initialUserId = m.uuid || "initial";
        await emit({
          type: "system",
          subtype: "init",
          session_id: "claude-session",
          claude_code_version: "2.1.300",
        });
        await emit({
          type: "assistant",
          ...(process.env.FIXTURE_SCENARIO !== "steer-old"
            ? { user_message_uuid: initialUserId }
            : {}),
          message: {
            id: "ready",
            content: [
              {
                type: "tool_use",
                id: "ready",
                name: "parent-ready",
                input: {},
              },
            ],
          },
        });
      } else {
        if (process.env.FIXTURE_SCENARIO === "steer-cancel") return;
        await emit({
          type: "result",
          subtype: "success",
          is_error: false,
          user_message_uuid: initialUserId,
          queued_turn_count: 1,
        });
        await emit({
          type: "assistant",
          parent_tool_use_id: "child-tool",
          agent_id: "child",
          session_id: "child-native-session",
          message: {
            id: "child-message",
            content: [{ type: "text", text: "Child private reply" }],
          },
        });
        await emit({
          type: "assistant",
          user_message_uuids: [initialUserId, m.uuid],
          message: {
            id: "steer-message",
            content: [{ type: "text", text: "Steer received" }],
          },
        });
        await emit({
          type: "result",
          subtype: "success",
          is_error: false,
          user_message_uuids: [initialUserId, m.uuid],
          queued_turn_count: 0,
        });
      }
      return;
    }
    if (process.env.FIXTURE_SCENARIO.startsWith("subagent")) {
      await emit({
        type: "system",
        subtype: "init",
        session_id: "claude-session",
      });
      await emit({
        type: "system",
        subtype: "task_started",
        task_id: "child",
        task_type: "local_agent",
        tool_use_id: "spawn-tool",
        description: "Analyze data",
      });
      await emit({
        type: "assistant",
        parent_tool_use_id: "child-tool",
        agent_id: "child",
        message: { content: [{ type: "text", text: "Child private reply" }] },
      });
      if (process.env.FIXTURE_SCENARIO === "subagent-foreground")
        await emit({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "spawn-tool",
                content: "Analysis done",
              },
            ],
          },
          tool_use_result: { status: "completed", content: [] },
        });
      else
        await emit({
          type: "system",
          subtype: "task_notification",
          task_id: "child",
          status: "completed",
          summary: "Analysis done",
        });
      await emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "Parent complete" }] },
      });
      await emit({ type: "result", subtype: "success", is_error: false });
      return;
    }
    if (process.env.FIXTURE_SCENARIO === "missing") {
      await emit({
        type: "result",
        is_error: true,
        subtype: "error_during_execution",
        errors: ["No conversation found with session ID: missing"],
      });
      process.exit(1);
    }
    await emit({
      type: "system",
      subtype: "init",
      session_id: "claude-session",
    });
    if (["hang", "stubborn"].includes(process.env.FIXTURE_SCENARIO)) {
      hang();
      return;
    }
    if (process.env.FIXTURE_SCENARIO !== "result-only")
      await emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello 🌍" },
        },
      });
    if (process.env.FIXTURE_SCENARIO !== "result-only")
      await emit({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello 🌍" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "fixture.txt" },
            },
          ],
        },
      });
    await emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-session",
      result: "Hello 🌍",
    });
    process.exit(0);
    return;
  }
  if (m.method === "initialize") {
    if (process.env.FIXTURE_SCENARIO === "config-initialize-error") {
      await emit({ id: m.id, error: { code: -32603, message: configError() } });
      return;
    }
    await emit({
      id: m.id,
      result:
        process.env.FIXTURE_SCENARIO === "bad-handshake"
          ? {}
          : { userAgent: "fixture/0.136.0" },
    });
    return;
  }
  if (m.method === "config/read") {
    if (process.env.FIXTURE_SCENARIO === "config-hang") return;
    await emit(
      process.env.FIXTURE_SCENARIO === "config-read-error"
        ? { id: m.id, error: { code: -32603, message: configError() } }
        : {
            id: m.id,
            result:
              process.env.FIXTURE_SCENARIO === "config-invalid-response"
                ? {}
                : { config: {} },
          },
    );
    return;
  }
  if (m.method === "thread/start" || m.method === "thread/resume") {
    if (
      process.env.FIXTURE_SCENARIO === "required" &&
      !args.includes("mcp_servers.miracle.required=true")
    ) {
      await write(process.stderr, "Miracle MCP must be required");
      process.exit(20);
    }
    if (realpathSync(m.params.cwd) !== process.cwd()) process.exit(11);
    if (
      m.method === "thread/resume" &&
      process.env.FIXTURE_SCENARIO === "large-history"
    ) {
      await emit({
        id: m.id,
        result: {
          thread: {
            id: "codex-session",
            turns: [
              {
                items: [
                  {
                    type: "userMessage",
                    content: [
                      {
                        type: "image",
                        url: `data:image/png;base64,${"a".repeat(33 * 1024 * 1024)}`,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      });
      return;
    }
    if (
      m.method === "thread/resume" &&
      process.env.FIXTURE_SCENARIO === "storage-error"
    ) {
      await emit({
        id: m.id,
        error: { code: -32603, message: "session database unavailable" },
      });
      return;
    }
    if (m.method === "thread/resume" && m.params.threadId === "missing") {
      await emit({
        id: m.id,
        error: { code: -32600, message: "thread not found: missing" },
      });
      return;
    }
    await emit({ id: m.id, result: { thread: { id: "codex-session" } } });
    return;
  }
  if (m.method === "turn/start") {
    if (
      m.params.input?.[0]?.type !== "text" ||
      !Array.isArray(m.params.input[0].text_elements)
    )
      process.exit(12);
    if (process.env.FIXTURE_SCENARIO === "images-echo")
      await emit({
        method: "item/started",
        params: {
          item: {
            type: "userMessage",
            id: "input-with-images",
            content: m.params.input,
          },
        },
      });
    if (process.env.FIXTURE_SCENARIO.startsWith("child-")) {
      await emit({
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      await emit({
        method: "item/agentMessage/delta",
        params: { itemId: "parent-early", delta: "Parent before response. " },
      });
      await emit({
        method: "turn/started",
        params: {
          threadId: "child-session",
          turn: { id: "child-turn", status: "inProgress" },
        },
      });
      await emit({
        method: "item/agentMessage/delta",
        params: {
          threadId: "child-session",
          turnId: "child-turn",
          itemId: "parent-final",
          delta: "Child private reply",
        },
      });
      await emit({
        method: "item/completed",
        params: {
          threadId: "child-session",
          turnId: "child-turn",
          item: {
            id: "child-final",
            type: "agentMessage",
            text: "Child final",
          },
        },
      });
      if (process.env.FIXTURE_SCENARIO === "child-error")
        await emit({
          method: "error",
          params: {
            threadId: "child-session",
            turnId: "child-turn",
            willRetry: false,
            error: { message: "Child failed" },
          },
        });
      await emit({
        method: "turn/completed",
        params: {
          threadId: "child-session",
          turn: { id: "child-turn", status: "completed", error: null },
        },
      });
      // A previous turn of a resumed root thread must be ignored as well.
      await emit({
        method: "item/agentMessage/delta",
        params: {
          turnId: "previous-turn",
          itemId: "previous-message",
          delta: "Previous turn",
        },
      });
      await emit({
        method: "turn/completed",
        params: {
          turn: { id: "previous-turn", status: "completed", error: null },
        },
      });
      await emit({
        id: m.id,
        result: { turn: { id: "turn-1", status: "inProgress" } },
      });
      await emit({
        method: "turn/started",
        params: {
          threadId: "child-session",
          turn: { id: "child-turn-2", status: "inProgress" },
        },
      });
      await emit({
        id: "child-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "child-session",
          turnId: "child-turn-2",
          itemId: "child-command",
          command: "pwd",
          reason: "Child asks permission",
        },
      });
      return;
    }
    await emit({
      id: m.id,
      result: { turn: { id: "turn-1", status: "inProgress" } },
    });
    if (process.env.FIXTURE_SCENARIO.startsWith("question")) {
      await emit({
        id: "native-question",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "codex-session",
          turnId: "turn-1",
          itemId: "q",
          questions: [
            {
              id: "output",
              header: "Output",
              question: "Choose output",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Table", description: "Rows" },
                { label: "Chart", description: "Bars" },
              ],
            },
          ],
        },
      });
      if (process.env.FIXTURE_SCENARIO === "question-ended") {
        process.on("SIGTERM", () => {});
        await emit({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed" } },
        });
      }
      return;
    }
    if (process.env.FIXTURE_SCENARIO.startsWith("steer")) {
      await emit({
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            id: "ready",
            command: "parent-ready",
          },
        },
      });
      return;
    }
    if (process.env.FIXTURE_SCENARIO === "subagent-activity") {
      const activity = async (kind, phase, agentThreadId = "child") =>
        emit({
          method: `item/${phase}`,
          params: {
            item: {
              type: "subAgentActivity",
              id: `activity-${kind}-${phase}-${agentThreadId}`,
              kind,
              agentThreadId,
              agentPath: `/root/${agentThreadId}`,
              model: "gpt-6-astra",
              reasoningEffort: "xhigh",
            },
          },
        });
      await activity("started", "started");
      // Completion of the reporting item is not completion of the child.
      await activity("started", "completed");
      await activity("interacted", "completed");
      await activity("started", "completed", "codex-session");
      await emit({
        method: "item/completed",
        params: {
          item: { type: "subAgentActivity", id: "malformed", kind: "started" },
        },
      });
      await emit({
        method: "item/completed",
        params: {
          threadId: "child",
          turnId: "child-turn",
          item: {
            id: "child-message",
            type: "agentMessage",
            text: "Private child reply",
          },
        },
      });
      await activity("interrupted", "completed", "cancelled-child");
      await activity("completed", "started");
      await activity("completed", "completed");
      await emit({
        method: "item/completed",
        params: {
          item: {
            id: "root-message",
            type: "agentMessage",
            text: "Parent complete",
          },
        },
      });
      await emit({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      return;
    }
    if (process.env.FIXTURE_SCENARIO === "subagent") {
      await emit({
        method: "item/completed",
        params: {
          item: {
            id: "spawn",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "codex-session",
            receiverThreadIds: ["child"],
            prompt: "Analyze data",
            agentsStates: { child: { status: "running", message: null } },
          },
        },
      });
      await emit({
        method: "turn/completed",
        params: {
          threadId: "child",
          turn: { id: "child-turn", status: "completed" },
        },
      });
      await emit({
        method: "item/completed",
        params: {
          item: {
            id: "root-message",
            type: "agentMessage",
            text: "Parent complete",
          },
        },
      });
      await emit({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      return;
    }
    if (["hang", "stubborn"].includes(process.env.FIXTURE_SCENARIO)) {
      hang();
      return;
    }
    if (process.env.FIXTURE_SCENARIO === "bad-json") {
      process.stdout.write("not-json\n");
      return;
    }
    if (process.env.FIXTURE_SCENARIO === "exit") {
      await write(process.stderr, "provider authentication failed");
      process.exit(2);
    }
    await emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "codex-session",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "Hello 🌍",
      },
    });
    await emit({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", id: "message-1", text: "Hello 🌍" },
      },
    });
    await emit({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "command-1",
          command: "pwd",
          cwd: process.cwd(),
          status: "inProgress",
        },
      },
    });
    await emit({
      id: 101,
      method: "item/commandExecution/requestApproval",
      params: { command: "pwd", reason: "Please approve" },
    });
    return;
  }
  if (m.id === "native-question" && m.result) {
    await emit({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
    return;
  }
  if (m.method === "turn/steer") {
    if (process.env.FIXTURE_SCENARIO === "steer-cancel") return;
    if (process.env.FIXTURE_SCENARIO === "steer-completion-first")
      await emit({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
    await emit({ id: m.id, result: { turnId: "turn-1" } });
    if (process.env.FIXTURE_SCENARIO !== "steer-completion-first")
      await emit({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
    return;
  }
  if (m.id === "child-approval" && m.result) {
    if (m.result.decision !== "decline") process.exit(22);
    await emit({
      method: "item/started",
      params: {
        item: {
          id: "parent-work",
          type: "commandExecution",
          command: "parent-ready",
          cwd: process.cwd(),
          status: "inProgress",
        },
      },
    });
    if (process.env.FIXTURE_SCENARIO === "child-cancel") return;
    await emit({
      method: "item/completed",
      params: {
        item: {
          id: "parent-final",
          type: "agentMessage",
          text: "Parent finished",
        },
      },
    });
    await emit({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", error: null } },
    });
    return;
  }
  if (m.id === 101 && m.result) {
    if (!["accept", "decline"].includes(m.result.decision)) process.exit(13);
    await emit({
      id: "approval-file",
      method: "item/fileChange/requestApproval",
      params: { reason: "Write fixture" },
    });
    return;
  }
  if (
    m.id === "approval-file" &&
    m.result &&
    process.env.FIXTURE_SCENARIO === "permissions"
  ) {
    await emit({
      id: "permissions",
      method: "item/permissions/requestApproval",
      params: {
        reason: "Write fixture",
        permissions: {
          network: null,
          fileSystem: { read: null, write: [process.cwd()] },
        },
      },
    });
    return;
  }
  if (m.id === "permissions" && m.result) {
    if (m.result.permissions.network === null) process.exit(21);
    await emit({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", error: null } },
    });
    return;
  }
  if (m.id === "approval-file" && m.result) {
    await emit({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", error: null } },
    });
    return;
  }
  if (m.method === "turn/interrupt") {
    await emit({ id: m.id, result: {} });
    await emit({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "interrupted" } },
    });
  }
});
