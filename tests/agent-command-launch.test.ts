import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentCommand,
  childAgentEnvironment,
} from "../src/server/agents/command.js";
import {
  AgentTransport,
  checkAgentCommand,
} from "../src/server/agents/transport.js";

describe("custom command subprocess launch", () => {
  it.each(["rejects", "omits"] as const)(
    "explains the structured protocol requirement when a wrapper %s managed arguments",
    async (behavior) => {
      const directory = await mkdtemp(
        join(tmpdir(), "miracle-command-incompatible-"),
      );
      try {
        const script = join(directory, "wrapper.mjs");
        await writeFile(
          script,
          `
          const args = process.argv.slice(2);
          if (args.includes('--version')) console.log('fixture-wrapper 1.0');
          else if (${JSON.stringify(behavior)} === 'rejects') {
            console.error('Unknown option --input-format; token=' + process.env.TEST_API_TOKEN);
            process.exit(2);
          } else console.log('Usage: wrapper [--model name]');
        `,
        );
        const command = `TEST_API_TOKEN=fixture-secret-123456 '${process.execPath}' '${script}'`;
        const error = await checkAgentCommand(
          "claude",
          command,
          directory,
        ).then(
          () => {
            throw new Error("Expected incompatible wrapper to fail");
          },
          (failure: Error) => failure,
        );
        expect(error.message).toMatch(/Claude Code.*stream-json/);
        expect(error.message).toMatch(/compatible.*CLI directly/i);
        expect(error.message).toMatch(
          /wrapper that forwards.*protocol arguments/i,
        );
        expect(error.message).not.toContain("fixture-secret-123456");
        if (behavior === "rejects") {
          expect(error.message).toContain("Unknown option --input-format");
          expect(error.message).toContain("token=<redacted>");
        } else expect(error.message).toContain("--input-format");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["codex", "claude"] as const)(
    "uses the same Node launcher for %s probes and runtime",
    async (provider) => {
      const directory = await mkdtemp(join(tmpdir(), "miracle-command-"));
      try {
        const script = join(directory, "агент cli.mjs");
        const log = join(directory, "argv.jsonl");
        await writeFile(
          script,
          `
        import { appendFileSync } from 'node:fs';
        const args = process.argv.slice(2);
        appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + '\\n');
        if (args.includes('--version')) console.log('fixture-cli 1.0');
        else if (args.includes('--help')) console.log('--stdio --input-format --output-format --include-partial-messages --permission-prompt-tool --mcp-config --resume');
        else console.log(JSON.stringify({type: 'ready', args}));
      `,
        );
        const quote = (value: string) =>
          "'" + value.replaceAll("'", "'\\''") + "'";
        const command = `ARGV_LOG=${quote(log)} ${quote(process.execPath)} --no-warnings ${quote(script)} --model custom`;
        const result = await checkAgentCommand(provider, command, directory);
        expect(result.version).toBe("fixture-cli 1.0");
        const built = buildAgentCommand(provider, command);
        const transport = new AgentTransport(
          built.executable,
          built.args,
          directory,
          childAgentEnvironment(process.env, built.env),
        );
        const messages: unknown[] = [];
        const errors: Error[] = [];
        transport.json(
          (message) => messages.push(message),
          (error) => errors.push(error),
        );
        expect((await transport.closed).code).toBe(0);
        expect(errors).toEqual([]);
        const calls = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls[0]).toEqual(["--version"]);
        const runtimeArgs =
          provider === "codex"
            ? ["app-server", "-c", 'model="custom"']
            : [
                "--model",
                "custom",
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--permission-prompt-tool",
                "mcp__miracle__permission_prompt",
              ];
        expect(calls[1]).toEqual([...runtimeArgs, "--help"]);
        expect(calls[2]).toEqual(runtimeArgs);
        expect(messages).toEqual([{ type: "ready", args: runtimeArgs }]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
