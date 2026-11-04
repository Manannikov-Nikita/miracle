import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildAgentCommand } from "../src/server/agents/command.js";
import { checkAgentCommand } from "../src/server/agents/transport.js";

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);

it("preserves a wrapper positional prefix through version, capability and runtime launches", async () => {
  const root = mkdtempSync(join(tmpdir(), "miracle-test-launcher-command-"));
  directories.push(root);
  const executable = join(root, "test-launcher");
  const log = join(root, "argv.jsonl");
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'agent' || args[1] !== 'claude') process.exit(2);
if (args.includes('--version')) console.log('fixture-claude 1.0');
else if (args.includes('--help')) console.log('--input-format --output-format --include-partial-messages --permission-prompt-tool --mcp-config --resume');
else console.log(JSON.stringify(args));
`,
    { mode: 0o700 },
  );
  const command = `'${executable}' agent claude`;
  const checked = await checkAgentCommand("claude", command, root);
  expect(checked.version).toBe("fixture-claude 1.0");
  const built = buildAgentCommand("claude", command);
  const runtime = JSON.parse(
    execFileSync(built.executable, built.args, { encoding: "utf8" }),
  );
  expect(runtime.slice(0, 2)).toEqual(["agent", "claude"]);
  expect(runtime).toContain("--input-format");
  expect(runtime).toContain("stream-json");
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls[0]).toEqual(["agent", "claude", "--version"]);
  expect(calls[1]).toEqual([...built.args, "--help"]);
  expect(calls[2]).toEqual(built.args);
  expect(
    buildAgentCommand("claude", "test-launcher agent claude").prefixArgs,
  ).toEqual(["agent", "claude"]);
});
