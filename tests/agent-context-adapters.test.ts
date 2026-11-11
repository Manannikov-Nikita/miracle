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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "miracle-context-")));
  dirs.push(cwd);
  const path = join(cwd, "messages.json");
  writeFileSync(path, JSON.stringify(fixture));
  const events: AdapterEvent[] = [];
  const process = startAgentTurn({
    provider,
    command: `FIXTURE_PROVIDER=${provider} FIXTURE_MESSAGES=${quote(path)} ${quote(globalThis.process.execPath)} ${quote(resolve("tests/fixtures/agents/context-provider.mjs"))}`,
    cwd,
    prompt: "Inspect context",
    mcp: { url: "http://127.0.0.1/mcp", token: "fixture-token" },
    onEvent: (event) => events.push(event),
  });
  await expect(process.completion).resolves.toEqual({
    sessionId: "root-session",
  });
  return events.filter((event) => event.type === "context-usage");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const codexUsage = (used: unknown, window: unknown = 4000, params = {}) => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId: "root-session",
    turnId: "root-turn",
    tokenUsage: {
      last: {
        totalTokens: used,
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 20,
        reasoningOutputTokens: 10,
      },
      total: { totalTokens: 9_000_000 },
      modelContextWindow: window,
    },
    ...params,
  },
});
const claudeMessage = (
  usage: unknown,
  model: unknown = "root-model",
  extra = {},
) => ({
  type: "assistant",
  message: { id: "response", model, usage, content: [] },
  ...extra,
});

describe("provider context telemetry", () => {
  it("uses latest Codex context, including early notifications, without cumulative spend or other turns", async () => {
    expect(
      await run("codex", {
        beforeStart: [codexUsage(640)],
        messages: [
          codexUsage(900, 8000, { threadId: "child-session" }),
          codexUsage(800, 8000, { turnId: "old-turn" }),
          codexUsage(480),
        ],
      }),
    ).toEqual([
      {
        type: "context-usage",
        usage: { provider: "codex", usedTokens: 640, contextWindow: 4000 },
      },
      {
        type: "context-usage",
        usage: { provider: "codex", usedTokens: 480, contextWindow: 4000 },
      },
    ]);
  });

  it("accepts zero/over-limit Codex usage and leaves absent or invalid capacity unknown", async () => {
    expect(
      await run("codex", {
        messages: [
          codexUsage(0, null),
          codexUsage(5000, 4000),
          codexUsage(42, 0),
          codexUsage(43, 4.5),
          codexUsage(44, "4000"),
        ],
      }),
    ).toEqual([
      { type: "context-usage", usage: { provider: "codex", usedTokens: 0 } },
      {
        type: "context-usage",
        usage: { provider: "codex", usedTokens: 5000, contextWindow: 4000 },
      },
      { type: "context-usage", usage: { provider: "codex", usedTokens: 42 } },
      { type: "context-usage", usage: { provider: "codex", usedTokens: 43 } },
      { type: "context-usage", usage: { provider: "codex", usedTokens: 44 } },
    ]);
  });

  it("ignores malformed Codex measurements without breaking successful completion", async () => {
    expect(
      await run("codex", {
        messages: [
          ...[null, "10", -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((value) =>
            codexUsage(value),
          ),
          JSON.stringify(codexUsage("NONFINITE")).replace(
            '"NONFINITE"',
            "1e400",
          ),
          codexUsage(1, 4000, { tokenUsage: null }),
        ],
      }),
    ).toEqual([]);
  });

  it("uses latest Claude root input including cache, with capacity only from its model", async () => {
    expect(
      await run("claude", {
        messages: [
          claudeMessage({
            input_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 900,
          }),
          claudeMessage({
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 800,
          }),
          claudeMessage({ input_tokens: 999 }, "child-model", {
            parent_tool_use_id: "child-tool",
          }),
          claudeMessage({ input_tokens: 998 }, "child-model", {
            agent_id: "child",
          }),
        ],
        result: {
          usage: { input_tokens: 500_000 },
          modelUsage: {
            "child-model": { inputTokens: 900_000, contextWindow: 8000 },
            "root-model": { inputTokens: 700_000, contextWindow: 4000 },
          },
        },
      }),
    ).toEqual([
      {
        type: "context-usage",
        usage: { provider: "claude", usedTokens: 600, model: "root-model" },
      },
      {
        type: "context-usage",
        usage: { provider: "claude", usedTokens: 60, model: "root-model" },
      },
      {
        type: "context-usage",
        usage: {
          provider: "claude",
          usedTokens: 60,
          model: "root-model",
          contextWindow: 4000,
        },
      },
    ]);
  });

  it("retains Claude's root model from message_start while ignoring child streams", async () => {
    expect(
      await run("claude", {
        messages: [
          {
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "response", model: "stream-model" },
            },
          },
          {
            type: "stream_event",
            agent_id: "child",
            event: {
              type: "message_start",
              message: { model: "child-model", usage: { input_tokens: 999 } },
            },
          },
          {
            type: "assistant",
            message: {
              id: "response",
              usage: { input_tokens: 0 },
              content: [],
            },
          },
        ],
        result: {
          modelUsage: {
            "stream-model": { contextWindow: 4000 },
            "child-model": { contextWindow: 8000 },
          },
        },
      }),
    ).toEqual([
      {
        type: "context-usage",
        usage: { provider: "claude", usedTokens: 0, model: "stream-model" },
      },
      {
        type: "context-usage",
        usage: {
          provider: "claude",
          usedTokens: 0,
          model: "stream-model",
          contextWindow: 4000,
        },
      },
    ]);
  });

  it("retains Claude stream input usage without adding output deltas", async () => {
    expect(
      await run("claude", {
        messages: [
          {
            type: "stream_event",
            event: {
              type: "message_start",
              message: {
                id: "stream",
                model: "root-model",
                usage: {
                  input_tokens: 10,
                  cache_creation_input_tokens: 20,
                  cache_read_input_tokens: 30,
                },
              },
            },
          },
          {
            type: "stream_event",
            event: { type: "message_delta", usage: { output_tokens: 1000 } },
          },
          {
            type: "result",
            agent_id: "child",
            subtype: "success",
            is_error: false,
            modelUsage: { "root-model": { contextWindow: 9000 } },
          },
        ],
        result: { modelUsage: { "root-model": { contextWindow: 4000 } } },
      }),
    ).toEqual([
      {
        type: "context-usage",
        usage: { provider: "claude", usedTokens: 60, model: "root-model" },
      },
      {
        type: "context-usage",
        usage: {
          provider: "claude",
          usedTokens: 60,
          model: "root-model",
          contextWindow: 4000,
        },
      },
    ]);
  });

  it("does not infer a Claude root model even from a single result model", async () => {
    const events = await run("claude", {
      messages: [
        {
          type: "assistant",
          message: { id: "response", content: [], usage: { input_tokens: 42 } },
        },
      ],
      result: { modelUsage: { "only-model": { contextWindow: 4000 } } },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event) =>
          event.type === "context-usage" &&
          event.usage.model === undefined &&
          event.usage.contextWindow === undefined,
      ),
    ).toBe(true);
  });

  it.each([
    {},
    { "other-model": { contextWindow: 8000 } },
    { "root-model": { contextWindow: -1 } },
    { "root-model": { contextWindow: Number.MAX_SAFE_INTEGER + 1 } },
  ])(
    "does not infer Claude capacity from absent, unrelated or invalid model usage: %j",
    async (modelUsage) => {
      const events = await run("claude", {
        messages: [claudeMessage({ input_tokens: 42 })],
        result: { modelUsage },
      });
      expect(events.length).toBeGreaterThan(0);
      expect(
        events.every(
          (event) =>
            event.type === "context-usage" &&
            event.usage.usedTokens === 42 &&
            event.usage.contextWindow === undefined,
        ),
      ).toBe(true);
    },
  );

  it("ignores invalid Claude usage without turning cumulative results into a context measurement", async () => {
    expect(
      await run("claude", {
        messages: [
          ...[
            null,
            {},
            { input_tokens: -1 },
            { input_tokens: "10" },
            { input_tokens: 1.5 },
            { input_tokens: 5, cache_read_input_tokens: -1 },
            {
              input_tokens: Number.MAX_SAFE_INTEGER,
              cache_creation_input_tokens: 1,
            },
          ].map((usage) => claudeMessage(usage)),
          JSON.stringify(claudeMessage({ input_tokens: "NONFINITE" })).replace(
            '"NONFINITE"',
            "1e400",
          ),
        ],
        result: {
          usage: { input_tokens: 9000 },
          modelUsage: {
            "root-model": { inputTokens: 9000, contextWindow: 4000 },
          },
        },
      }),
    ).toEqual([]);
  });

  it.each(["codex", "claude"] as const)(
    "%s older protocol completes with no telemetry",
    async (provider) => {
      expect(await run(provider, {})).toEqual([]);
    },
  );
});
