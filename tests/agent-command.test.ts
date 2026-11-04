import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseAgentCommand,
  buildAgentCommand,
  childAgentEnvironment,
} from "../src/server/agents/command.js";

describe("agent command", () => {
  it("parses quotes, empty arguments, and leading environment assignments without a shell", () => {
    expect(
      parseAgentCommand("MODE='local mode' '/bin/my cli' --model \"a b\" ''"),
    ).toEqual({
      executable: "/bin/my cli",
      args: ["--model", "a b", ""],
      env: { MODE: "local mode" },
    });
  });
  it.each([
    "codex | cat",
    "codex && touch x",
    "codex $(whoami)",
    "codex `whoami`",
    "codex > x",
    'codex "unterminated',
  ])("rejects shell syntax %s", (command) => {
    expect(() => parseAgentCommand(command)).toThrow();
  });
  it("maps Codex model and permissions into app-server configuration without losing user flags", () => {
    const c = buildAgentCommand(
      "codex",
      'codex --model test -a on-request -s workspace-write -c model_reasoning_effort="high"',
    );
    expect(c.args).toEqual([
      "app-server",
      "-c",
      'model="test"',
      "-c",
      'approval_policy="on-request"',
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "model_reasoning_effort=high",
    ]);
  });
  it.each([
    ["codex", "codex -C elsewhere"],
    ["claude", "claude --resume previous"],
    ["claude", "claude --output-format text"],
  ])("rejects managed flags for %s", (provider, command) => {
    expect(() =>
      buildAgentCommand(provider as "codex" | "claude", command),
    ).toThrow(/managed|Miracle/i);
  });
  it("does not expose assignment secrets in previews or inherit Miracle server secrets", () => {
    const c = buildAgentCommand(
      "claude",
      "API_TOKEN=secret claude --model sonnet",
    );
    expect(c.preview).not.toContain("secret");
    expect(
      childAgentEnvironment(
        {
          MIRACLE_CONTROL_TOKEN: "server",
          MIRACLE_ENCRYPTION_KEY: "key",
          PATH: "/bin",
        },
        { MIRACLE_CONTROL_TOKEN: "override", MODE: "ok" },
      ),
    ).toEqual({ PATH: "/bin", MODE: "ok" });
  });
  it("rejects whitespace-obscured configuration overrides of managed cwd", () => {
    expect(() =>
      buildAgentCommand("codex", `codex -c 'cwd = "elsewhere"'`),
    ).toThrow(/Miracle/);
  });
  it("redacts secret configuration and wrapper assignments in command previews", () => {
    expect(
      buildAgentCommand(
        "codex",
        "env OPENAI_API_KEY=private-key codex -c 'provider.token=private-token'",
      ).preview,
    ).not.toMatch(/private-key|private-token/);
  });

  it("preserves additional MCP servers configured by the user", () => {
    expect(
      buildAgentCommand(
        "codex",
        "codex -c mcp_servers.other.url=https://example.test/mcp",
      ).args,
    ).toContain("mcp_servers.other.url=https://example.test/mcp");
  });

  it.each([
    ["npx -y @openai/codex", ["-y", "@openai/codex"]],
    [
      "npx --package=@openai/codex -- codex",
      ["--package=@openai/codex", "--", "codex"],
    ],
    [
      "node --no-warnings '/tmp/агент cli.mjs'",
      ["--no-warnings", "/tmp/агент cli.mjs"],
    ],
    [
      "node --import /tmp/register.mjs /tmp/cli.mjs",
      ["--import", "/tmp/register.mjs", "/tmp/cli.mjs"],
    ],
    [
      "env -u CLAUDECODE MODE=local node --no-warnings /tmp/cli.mjs",
      [
        "-u",
        "CLAUDECODE",
        "MODE=local",
        "node",
        "--no-warnings",
        "/tmp/cli.mjs",
      ],
    ],
    [
      "env -- MODE=local node --no-warnings /tmp/cli.mjs",
      ["--", "MODE=local", "node", "--no-warnings", "/tmp/cli.mjs"],
    ],
  ])(
    "keeps the launcher prefix before Codex transport arguments: %s",
    (launcher, prefix) => {
      expect(
        buildAgentCommand("codex", `${launcher} --model custom -a on-request`)
          .args,
      ).toEqual([
        ...prefix,
        "app-server",
        "-c",
        'model="custom"',
        "-c",
        'approval_policy="on-request"',
      ]);
    },
  );

  it("expands the executable home directory without evaluating shell expressions", () => {
    expect(buildAgentCommand("codex", "'~/my cli/codex'").executable).toBe(
      join(homedir(), "my cli/codex"),
    );
  });

  it.each([
    "npx --call codex",
    "node --eval code",
    "node --import",
    "npx -y",
    "env --split-string 'codex --model custom'",
    "env -i codex",
  ])(
    "rejects unsupported or incomplete launchers with a wrapper instruction: %s",
    (command) => {
      expect(() => buildAgentCommand("codex", command)).toThrow(
        /wrapper script/i,
      );
    },
  );
});
