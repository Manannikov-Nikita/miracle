import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkAgentCommand } from "../src/server/agents/transport.js";
import { startAgentTurn } from "../src/server/agents/adapter.js";

const directories: string[] = [];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function setup(scenario = "normal") {
  const cwd = mkdtempSync(join(tmpdir(), "miracle-codex-config-"));
  directories.push(cwd);
  const trace = join(cwd, "trace.jsonl");
  const command = `FIXTURE_PROVIDER=codex FIXTURE_SCENARIO=${scenario} FIXTURE_TRACE=${quote(trace)} TEST_API_TOKEN=fixture-config-secret ${quote(process.execPath)} ${quote(resolve("tests/fixtures/agents/provider.mjs"))} --model selected -c model_reasoning_effort=xhigh`;
  const events = () =>
    existsSync(trace)
      ? readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { cwd, trace, command, events };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Codex configuration preflight", () => {
  it("loads the configured provider settings without creating a thread or starting a model turn", async () => {
    const f = setup();
    await expect(
      checkAgentCommand("codex", f.command, f.cwd),
    ).resolves.toMatchObject({ version: "codex-cli 0.136.0" });
    const events = f.events();
    expect(
      events.filter((event) => event.wire).map((event) => event.wire.method),
    ).toEqual(["initialize", "initialized", "config/read"]);
    expect(
      events.find((event) => event.wire?.method === "config/read")?.wire.params,
    ).toEqual({ includeLayers: false, cwd: f.cwd });
    expect(events.find((event) => event.args)?.args).toEqual([
      "app-server",
      "-c",
      'model="selected"',
      "-c",
      "model_reasoning_effort=xhigh",
    ]);
  });

  it.each([
    "config-initialize-error",
    "config-read-error",
    "config-exit-error",
  ])(
    "rejects %s even though version and help succeed, with redacted actionable detail",
    async (scenario) => {
      const f = setup(scenario);
      const error = await checkAgentCommand("codex", f.command, f.cwd).catch(
        (value) => value,
      );
      expect(error).toMatchObject({
        code: "AGENT_CONFIGURATION_INVALID",
        statusCode: 400,
      });
      expect(error.message).toMatch(/конфигурац/i);
      expect(error.message).toContain("config.toml");
      expect(error.message).toContain("ultra");
      expect(error.message).toContain("<redacted>");
      expect(error.message).not.toContain("fixture-config-secret");
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

  it("rejects an invalid config response instead of approving an incompatible executable", async () => {
    const f = setup("config-invalid-response");
    await expect(
      checkAgentCommand("codex", f.command, f.cwd),
    ).rejects.toMatchObject({ code: "AGENT_CONFIGURATION_INVALID" });
  });

  it("redacts sensitive command configuration echoed in a provider error", async () => {
    const f = setup("config-read-error");
    const error = await checkAgentCommand(
      "codex",
      f.command + ` -c 'provider.api_key="fixture-inline-secret"'`,
      f.cwd,
    ).catch((value) => value);
    expect(error).toMatchObject({ code: "AGENT_CONFIGURATION_INVALID" });
    expect(error.message).not.toContain("fixture-inline-secret");
    expect(error.message).toContain("provider.api_key=");
  });

  it("stops a hanging configuration probe when the request is cancelled", async () => {
    const f = setup("config-hang");
    const controller = new AbortController();
    const checking = checkAgentCommand(
      "codex",
      f.command,
      f.cwd,
      controller.signal,
    ).catch((error) => error);
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const events = f.events();
        if (events.some((event) => event.wire?.method === "config/read")) {
          pid = events.find((event) => event.pid)?.pid;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    expect(await checking).toMatchObject({ code: "AGENT_CANCELLED" });
    expect(pid).toBeTypeOf("number");
    expect(() => process.kill(pid!, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("bounds an unresponsive configuration probe and cleans up its process", async () => {
    const f = setup("config-hang");
    const error = await checkAgentCommand("codex", f.command, f.cwd).catch(
      (value) => value,
    );
    expect(error).toMatchObject({
      code: "AGENT_CONFIGURATION_INVALID",
      statusCode: 400,
    });
    expect(error.message).toMatch(/timed out/);
    const pid = f.events().find((event) => event.pid)?.pid;
    expect(pid).toBeTypeOf("number");
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  }, 12000);

  it("prevents a chat turn from starting when provider configuration is invalid", async () => {
    const f = setup("config-read-error");
    const process = startAgentTurn({
      provider: "codex",
      command: f.command,
      cwd: f.cwd,
      prompt: "hello",
      mcp: { url: "http://127.0.0.1/mcp", token: "fixture-token" },
      onEvent: (event) => {
        if (event.type === "approval") process.respond(event.id, "allow");
      },
    });
    await expect(process.completion).rejects.toMatchObject({
      code: "AGENT_CONFIGURATION_INVALID",
    });
    expect(f.events().filter((event) => event.args)).toHaveLength(1);
    expect(
      f.events().some((event) => event.wire?.method === "turn/start"),
    ).toBe(false);
  });
});
