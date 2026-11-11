import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startAgentTurn,
  type AdapterEvent,
} from "../src/server/agents/adapter.js";

const dirs: string[] = [];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function run(provider: "codex" | "claude", fixture: object) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "miracle-activity-")));
  dirs.push(cwd);
  const path = join(cwd, "messages.json");
  writeFileSync(path, JSON.stringify(fixture));
  const events: AdapterEvent[] = [];
  const process = startAgentTurn({
    provider,
    command: `FIXTURE_PROVIDER=${provider} FIXTURE_MESSAGES=${quote(path)} ${quote(globalThis.process.execPath)} ${quote(resolve("tests/fixtures/agents/context-provider.mjs"))}`,
    cwd,
    prompt: "Inspect activity",
    mcp: { url: "http://127.0.0.1/mcp", token: "fixture-token" },
    onEvent: (event) => events.push(event),
  });
  await expect(process.completion).resolves.toEqual({
    sessionId: "root-session",
  });
  return events.filter((event) => event.type === "action");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const toolUse = (
  id: string,
  name: string,
  input: unknown = {},
  extra = {},
) => ({
  type: "assistant",
  message: {
    id: `message-${id}`,
    content: [{ type: "tool_use", id, name, input }],
  },
  ...extra,
});
const toolResult = (
  id: string,
  content: unknown,
  is_error = false,
  extra = {},
) => ({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content, is_error }],
  },
  ...extra,
});
const plan = (steps: unknown, extra = {}) => ({
  method: "turn/plan/updated",
  params: {
    threadId: "root-session",
    turnId: "root-turn",
    plan: steps,
    ...extra,
  },
});

describe("provider activity lifecycle", () => {
  it("pairs Claude tool starts and results by ID without duplicating repeated frames or equal calls", async () => {
    const input = { file_path: "report.sql" };
    const events = await run("claude", {
      messages: [
        toolUse("read-1", "Read", input),
        toolUse("read-1", "Read", input),
        toolResult("read-1", "Read 10 lines"),
        toolResult("read-1", "Read 10 lines"),
        toolUse("read-2", "Read", input),
        toolResult("read-2", "Read 10 lines"),
      ],
    });
    expect(events).toEqual([
      {
        type: "action",
        text: "Read",
        details: { id: "read-1", type: "toolUse", phase: "started", input },
      },
      {
        type: "action",
        text: "Read",
        details: {
          id: "read-1",
          type: "toolUse",
          phase: "completed",
          status: "completed",
          isError: false,
          result: "Read 10 lines",
        },
      },
      {
        type: "action",
        text: "Read",
        details: { id: "read-2", type: "toolUse", phase: "started", input },
      },
      {
        type: "action",
        text: "Read",
        details: {
          id: "read-2",
          type: "toolUse",
          phase: "completed",
          status: "completed",
          isError: false,
          result: "Read 10 lines",
        },
      },
    ]);
  });

  it("preserves failed Claude tool outcomes and ignores child or unknown tool results", async () => {
    const events = await run("claude", {
      messages: [
        toolUse("child-1", "Bash", {}, { parent_tool_use_id: "task" }),
        toolResult("child-1", "Child result", true),
        toolUse("child-2", "Write", {}, { agent_id: "child" }),
        toolResult("orphan", "Untracked result"),
        toolUse("root", "Bash", { command: "false" }),
        toolResult("root", "Wrong child result", false, {
          parent_tool_use_id: "task",
        }),
        toolResult("root", "Command exited with code 1", true),
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "action",
      text: "Bash",
      details: {
        id: "root",
        type: "toolUse",
        phase: "completed",
        status: "failed",
        isError: true,
        result: "Command exited with code 1",
      },
    });
  });

  it("bounds Claude result text, excludes image payloads and preserves existing secret redaction", async () => {
    const events = await run("claude", {
      messages: [
        toolUse("read", "Read"),
        toolResult("read", [
          {
            type: "image",
            source: { type: "base64", data: "DO-NOT-EXPOSE-IMAGE" },
          },
          { type: "text", text: "fixture-token" },
          { type: "text", text: "x".repeat(5000) },
        ]),
      ],
    });
    expect(events).toHaveLength(2);
    const result = events[1].details?.result as string;
    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result.length).toBeGreaterThan(3900);
    expect(result).toMatch(/^<redacted>\nx+$/);
    expect(JSON.stringify(events)).not.toContain("DO-NOT-EXPOSE-IMAGE");
  });

  it("reports root Codex plan updates with stable identity and excludes old turns and children", async () => {
    const first = [{ step: "Inspect schema", status: "inProgress" }];
    const second = [
      { step: "Inspect schema", status: "completed" },
      { step: "Write query", status: "pending" },
    ];
    expect(
      await run("codex", {
        beforeStart: [plan(first)],
        messages: [
          plan(first, { threadId: "child-session" }),
          plan(first, { turnId: "old-turn" }),
          plan(second, { explanation: "Schema is available" }),
        ],
      }),
    ).toEqual([
      {
        type: "action",
        text: "План работы",
        details: {
          id: "plan:root-turn",
          type: "plan",
          phase: "updated",
          plan: first,
        },
      },
      {
        type: "action",
        text: "План работы",
        details: {
          id: "plan:root-turn",
          type: "plan",
          phase: "updated",
          plan: second,
          explanation: "Schema is available",
        },
      },
    ]);
  });

  it("ignores invalid Codex plans and bounds valid public plan fields", async () => {
    const events = await run("codex", {
      messages: [
        plan(null),
        plan([{ step: "invalid", status: "invented" }, null]),
        plan(
          Array.from({ length: 70 }, () => ({
            step: "x".repeat(4000),
            status: "pending",
          })),
          { explanation: "y".repeat(6000) },
        ),
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].details?.plan).toHaveLength(50);
    expect(
      (events[0].details?.plan as { step: string }[])[0].step,
    ).toHaveLength(2000);
    expect(events[0].details?.explanation).toHaveLength(4000);
  });
});
