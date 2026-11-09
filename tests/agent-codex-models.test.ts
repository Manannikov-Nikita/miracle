import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startAgentTurn } from "../src/server/agents/adapter";

const directories: string[] = [];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function setup(scenario = "normal", extra = "") {
  const cwd = mkdtempSync(join(tmpdir(), "miracle-codex-models-"));
  directories.push(cwd);
  const trace = join(cwd, "trace.jsonl");
  const command = `MODEL_FIXTURE_SCENARIO=${scenario} MODEL_FIXTURE_TRACE=${quote(trace)} TEST_API_TOKEN=fixture-secret-token ${quote(process.execPath)} ${quote(resolve("tests/fixtures/agents/codex-models.mjs"))} ${extra}`;
  const events = () =>
    existsSync(trace)
      ? readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const start = (
    modelSettings?: { model?: string; reasoningEffort?: string },
    resumeSessionId?: string,
  ) =>
    startAgentTurn({
      provider: "codex",
      command,
      cwd,
      prompt: "fixture only",
      modelSettings,
      resumeSessionId,
      mcp: { url: "http://127.0.0.1:9999/mcp", token: "fixture-mcp-token" },
      onEvent() {},
    });
  return { cwd, command, events, start };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Codex per-chat models", () => {
  it("applies the requested model and effort to both resumed thread and new turn", async () => {
    const f = setup();
    await f.start(
      { model: "model-fast", reasoningEffort: "high" },
      "old-session",
    ).completion;
    const wire = f
      .events()
      .flatMap((event) => (event.wire ? [event.wire] : []));
    expect(
      wire.find((event) => event.method === "thread/resume").params,
    ).toMatchObject({
      threadId: "old-session",
      model: "model-fast",
      config: { model_reasoning_effort: "high" },
    });
    expect(
      wire.find((event) => event.method === "turn/start").params,
    ).toMatchObject({ model: "model-fast", effort: "high" });
  });
  it("explicit reset resolves profile defaults rather than inheriting resumed settings", async () => {
    const f = setup();
    await f.start({}, "old-session").completion;
    const turn = f
      .events()
      .find((event) => event.wire?.method === "turn/start").wire;
    expect(turn.params).toMatchObject({ model: "model-deep", effort: "high" });
  });
  it("uses the selected model's default effort instead of the profile model's effort", async () => {
    const f = setup();
    await f.start({ model: "model-fast" }).completion;
    const start = f
      .events()
      .find((event) => event.wire?.method === "thread/start").wire;
    expect(start.params).toMatchObject({
      model: "model-fast",
      config: { model_reasoning_effort: "low" },
    });
    expect(
      f.events().find((event) => event.wire?.method === "turn/start").wire
        .params.effort,
    ).toBe("low");
  });
  it("keeps untouched legacy chats free from model discovery or overrides", async () => {
    const f = setup();
    await f.start().completion;
    expect(
      f.events().some((event) => event.wire?.method === "model/list"),
    ).toBe(false);
    expect(
      f.events().find((event) => event.wire?.method === "turn/start").wire
        .params,
    ).not.toHaveProperty("model");
    expect(
      f.events().find((event) => event.wire?.method === "turn/start").wire
        .params,
    ).not.toHaveProperty("effort");
  });
  it.each([undefined, "old-session"])(
    "runs a model without reasoning levels without sending an effort (resume: %s)",
    async (resumeSessionId) => {
      const f = setup("no-efforts");
      await f.start({ model: "model-plain" }, resumeSessionId).completion;
      const wire = f
        .events()
        .flatMap((event) => (event.wire ? [event.wire] : []));
      const thread = wire.find(
        (event) =>
          event.method === (resumeSessionId ? "thread/resume" : "thread/start"),
      );
      expect(thread.params.model).toBe("model-plain");
      expect(thread.params.config ?? {}).not.toHaveProperty(
        "model_reasoning_effort",
      );
      const turn = wire.find((event) => event.method === "turn/start");
      expect(turn.params.model).toBe("model-plain");
      expect(turn.params).not.toHaveProperty("effort");
    },
  );
  it("rejects an explicit effort for a model without reasoning levels", async () => {
    const f = setup("no-efforts");
    await expect(
      f.start({ model: "model-plain", reasoningEffort: "high" }).completion,
    ).rejects.toMatchObject({ code: "AGENT_REASONING_UNSUPPORTED" });
    expect(
      f.events().some((event) => event.wire?.method?.startsWith("thread/")),
    ).toBe(false);
  });
  it("cancels during catalog discovery before starting a native thread", async () => {
    const f = setup("hang");
    const running = f.start({ model: "model-fast" });
    const completion = running.completion.catch((error) => error);
    for (let i = 0; i < 200; i++) {
      if (f.events().some((event) => event.wire?.method === "model/list"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      f.events().some((event) => event.wire?.method === "model/list"),
    ).toBe(true);
    await running.cancel();
    expect(await completion).toMatchObject({ code: "AGENT_CANCELLED" });
    expect(
      f.events().some((event) => event.wire?.method?.startsWith("thread/")),
    ).toBe(false);
  });
  it.each([
    [{ model: "unlisted" }, "AGENT_MODEL_UNAVAILABLE"],
    [
      { model: "model-fast", reasoningEffort: "ultra" },
      "AGENT_REASONING_UNSUPPORTED",
    ],
  ] as const)(
    "rejects an unavailable selection before any model turn: %j",
    async (settings, code) => {
      const f = setup();
      await expect(f.start(settings).completion).rejects.toMatchObject({
        code,
      });
      expect(
        f
          .events()
          .some(
            (event) =>
              event.wire?.method?.startsWith("thread/") ||
              event.wire?.method === "turn/start",
          ),
      ).toBe(false);
    },
  );
});

describe("Codex model discovery", () => {
  async function discover(f: ReturnType<typeof setup>, signal?: AbortSignal) {
    const { discoverCodexModels } =
      await import("../src/server/agents/codex-models");
    return discoverCodexModels(f.command, f.cwd, signal);
  }
  it("does not execute a profile command for an already aborted request", async () => {
    const f = setup();
    await expect(discover(f, AbortSignal.abort())).rejects.toMatchObject({
      code: "AGENT_CANCELLED",
    });
    expect(f.events()).toEqual([]);
  });
  it("bounds an unresponsive model list and closes its process", async () => {
    const f = setup("hang");
    await expect(discover(f)).rejects.toMatchObject({
      code: "AGENT_MODELS_UNAVAILABLE",
    });
    expect(() => process.kill(f.events()[0].pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  }, 10000);
  it("pages through the catalog, honors CLI defaults and returns only safe model fields", async () => {
    const f = setup(
      "normal",
      "--model model-fast -c model_reasoning_effort=high",
    );
    const catalog = await discover(f);
    expect(catalog).toMatchObject({
      defaultModel: "model-fast",
      defaultReasoningEffort: "high",
    });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "model-fast",
      "model-deep",
    ]);
    expect(
      catalog.models[1].reasoningEfforts.map((effort) => effort.id),
    ).toEqual(["high", "ultra"]);
    expect(catalog.models[1].defaultReasoningEffort).toBe("high");
    const serialized = JSON.stringify(catalog);
    for (const secret of [
      "private-config-key",
      "private-layer",
      "never-return-this",
      "fixture-secret-token",
    ])
      expect(serialized).not.toContain(secret);
    const methods = f
      .events()
      .flatMap((event) => (event.wire ? [event.wire.method] : []));
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "config/read",
      "model/list",
      "model/list",
    ]);
    expect(() => process.kill(f.events()[0].pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
  it("uses the catalog default when no model was configured", async () => {
    expect(await discover(setup("catalog-default"))).toMatchObject({
      defaultModel: "model-fast",
      defaultReasoningEffort: "low",
    });
  });
  it.each(["unsupported", "invalid", "empty", "repeat"])(
    "rejects %s catalogs with sanitized actionable errors",
    async (scenario) => {
      const error = await discover(setup(scenario)).catch((value) => value);
      expect(error).toMatchObject({ code: "AGENT_MODELS_UNAVAILABLE" });
      expect(error.message).not.toContain("fixture-secret-token");
      expect(error.message).toMatch(/Codex/);
    },
  );
  it("cancels a hanging catalog and closes its process without starting a turn", async () => {
    const f = setup("hang");
    const controller = new AbortController();
    const pending = discover(f, controller.signal).catch((error) => error);
    for (let i = 0; i < 200; i++) {
      if (f.events().some((event) => event.wire?.method === "model/list"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      f.events().some((event) => event.wire?.method === "model/list"),
    ).toBe(true);
    controller.abort();
    expect(await pending).toMatchObject({ code: "AGENT_CANCELLED" });
    expect(() => process.kill(f.events()[0].pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
});
