import { appendFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const args = process.argv.slice(2),
  mode = process.env.FIXTURE_PROVIDER;
const trace = (data) => {
  if (process.env.FIXTURE_TRACE)
    appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(data) + "\n");
};
if (args.includes("--version")) {
  console.log(
    mode === "claude" ? "2.1.200 (Claude Code)" : "codex-cli 0.136.0",
  );
  process.exit(0);
}
if (args.includes("--help") && process.env.FIXTURE_SCENARIO === "old-cli") {
  console.log("old CLI without structured protocol");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(
    mode === "claude"
      ? "--input-format --output-format --verbose --include-partial-messages --permission-prompt-tool --mcp-config --resume"
      : "--stdio --listen app-server",
  );
  process.exit(0);
}
if (
  mode === "codex" &&
  process.env.FIXTURE_SCENARIO === "required" &&
  !args.includes("mcp_servers.miracle.required=true")
) {
  process.stderr.write("Miracle MCP must be required");
  process.exit(20);
}
trace({
  args,
  cwd: process.cwd(),
  control: process.env.MIRACLE_CONTROL_TOKEN,
  token: !!process.env.MIRACLE_AGENT_MCP_TOKEN,
});
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
    process.stdout.write(b.subarray(0, pivot));
    await new Promise((r) => setTimeout(r, 3));
    process.stdout.write(b.subarray(pivot));
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
    await emit({
      id: m.id,
      result:
        process.env.FIXTURE_SCENARIO === "bad-handshake"
          ? {}
          : { userAgent: "fixture/0.136.0" },
    });
    return;
  }
  if (m.method === "thread/start" || m.method === "thread/resume") {
    if (realpathSync(m.params.cwd) !== process.cwd()) process.exit(11);
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
    if (["hang", "stubborn"].includes(process.env.FIXTURE_SCENARIO)) {
      hang();
      return;
    }
    if (process.env.FIXTURE_SCENARIO === "bad-json") {
      process.stdout.write("not-json\n");
      return;
    }
    if (process.env.FIXTURE_SCENARIO === "exit") {
      process.stderr.write("provider authentication failed");
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
