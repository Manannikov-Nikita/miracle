import { homedir } from "node:os";
import { basename, join } from "node:path";

export type AgentProvider = "codex" | "claude";
export interface ParsedAgentCommand {
  executable: string;
  args: string[];
  env: Record<string, string>;
}

/** A deliberately small argv grammar. Nothing is ever evaluated by a shell. */
export function parseAgentCommand(command: string): ParsedAgentCommand {
  if (!command.trim() || command.length > 16_384 || /[\0\r\n]/.test(command))
    throw new Error("Enter a CLI command on one line");
  const words: string[] = [];
  let word = "",
    quote = "",
    active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
      continue;
    }
    if (c === "\\") {
      const next = command[++i];
      if (next === undefined) throw new Error("Unfinished command escape");
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      active = true;
      continue;
    }
    if (c === "$" || c === "`" || (!quote && /[|&;<>()[\]{}]/.test(c)))
      throw new Error(
        "Shell operators and substitutions are unsupported; use an executable wrapper script",
      );
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      active = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (active) {
        words.push(word);
        word = "";
        active = false;
      }
    } else {
      word += c;
      active = true;
    }
  }
  if (quote) throw new Error("Unclosed command quote");
  if (active) words.push(word);
  const env: Record<string, string> = {};
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
    const item = words.shift()!;
    const i = item.indexOf("=");
    env[item.slice(0, i)] = item.slice(i + 1);
  }
  const executable = words.shift();
  if (!executable) throw new Error("The command needs an executable");
  return { executable: expandHomePath(executable), args: words, env };
}

const expandHomePath = (value: string) =>
  value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

/** Locate the provider argv without interpreting the command through a shell. */
function agentLaunchPrefix(parsed: ParsedAgentCommand): string[] {
  let i = 0;
  const prefix: string[] = [];
  const unsupported = (program: string): never => {
    throw new Error(
      `Unsupported or incomplete ${program} launcher; use an executable wrapper script that forwards CLI arguments`,
    );
  };
  const takeValue = (program: string) => {
    const value = parsed.args[i++];
    if (!value || value.startsWith("-")) unsupported(program);
    prefix.push(value!);
    return value!;
  };
  let program = basename(parsed.executable).replace(/\.(?:exe|cmd)$/i, "");
  // env can wrap a runtime or package runner; each iteration consumes its program.
  while (program === "env") {
    let options = true;
    while (i < parsed.args.length) {
      const arg = parsed.args[i]!;
      if (options && arg === "--") {
        prefix.push(arg);
        i++;
        options = false;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        prefix.push(arg);
        i++;
        options = false;
      } else if (
        options &&
        (arg === "-u" || arg === "--unset" || arg.startsWith("--unset="))
      ) {
        prefix.push(arg);
        i++;
        const name = arg.includes("=")
          ? arg.slice(arg.indexOf("=") + 1)
          : takeValue(program);
        if (!name || name.startsWith("MIRACLE_")) unsupported(program);
      } else if (arg.startsWith("-")) unsupported(program);
      else break;
    }
    const executable = expandHomePath(takeValue(program));
    prefix[prefix.length - 1] = executable;
    program = basename(executable).replace(/\.(?:exe|cmd)$/i, "");
  }
  if (program === "node" || program === "nodejs" || program === "npx") {
    const flags =
      program === "npx"
        ? ["-y", "--yes", "-n", "--no", "--no-install"]
        : [
            "--no-warnings",
            "--no-deprecation",
            "--enable-source-maps",
            "--trace-warnings",
          ];
    const valued =
      program === "npx"
        ? ["-p", "--package"]
        : [
            "-r",
            "--require",
            "--import",
            "--loader",
            "--experimental-loader",
            "-C",
            "--conditions",
          ];
    while (i < parsed.args.length && parsed.args[i]!.startsWith("-")) {
      const arg = parsed.args[i++]!;
      prefix.push(arg);
      if (arg === "--") break;
      const equal = arg.indexOf("=");
      const flag = equal >= 0 ? arg.slice(0, equal) : arg;
      if (valued.includes(flag)) {
        if (equal < 0) takeValue(program);
        else if (!arg.slice(equal + 1)) unsupported(program);
      } else if (!flags.includes(arg)) unsupported(program);
    }
    const entrypoint = expandHomePath(takeValue(program));
    prefix[prefix.length - 1] = entrypoint;
  }
  // Preserve the existing executable-wrapper convention: positional prefix,
  // then provider flags. Wrapper-specific flags belong inside the wrapper script.
  while (i < parsed.args.length && !parsed.args[i]!.startsWith("-")) {
    const value = parsed.args[i++]!;
    if (
      [
        "exec",
        "e",
        "resume",
        "app-server",
        "login",
        "logout",
        "mcp",
        "review",
      ].includes(value)
    )
      throw new Error(
        "Miracle manages the provider subcommand; configure the base CLI command",
      );
    prefix.push(value);
  }
  return prefix;
}

export function childAgentEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ ...base, ...overrides }).filter(
      ([key, value]) =>
        value !== undefined &&
        !/^(MIRACLE_|CLAUDE_CODE_RESUME_INTERRUPTED_TURN$)/.test(key),
    ),
  );
}
const quoteArg = (value: string) =>
  /^[A-Za-z0-9_./:=@-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";

export function buildAgentCommand(provider: AgentProvider, command: string) {
  const parsed = parseAgentCommand(command);
  const prefixArgs = agentLaunchPrefix(parsed);
  const args: string[] = [...prefixArgs];
  let i = prefixArgs.length;
  if (provider === "codex") args.push("app-server");
  const managed =
    provider === "codex"
      ? [
          "-C",
          "--cd",
          "--listen",
          "--stdio",
          "--remote",
          "--remote-auth-token-env",
          "-i",
          "--image",
        ]
      : [
          "-p",
          "--print",
          "--output-format",
          "--input-format",
          "--include-partial-messages",
          "--resume",
          "-r",
          "--continue",
          "-c",
          "--session-id",
          "--permission-prompt-tool",
          "--permission-prompts",
          "--mcp-config",
          "--strict-mcp-config",
          "--bare",
          "--bg",
          "--cloud",
        ];
  const mappings: Record<string, string> = {
    "-m": "model",
    "--model": "model",
    "-a": "approval_policy",
    "--ask-for-approval": "approval_policy",
    "-s": "sandbox_mode",
    "--sandbox": "sandbox_mode",
    "--local-provider": "model_provider",
  };
  while (i < parsed.args.length) {
    const arg = parsed.args[i++]!;
    const equal = arg.indexOf("=");
    const flag = equal >= 0 ? arg.slice(0, equal) : arg;
    if (managed.includes(flag) || (provider === "codex" && /^-C./.test(arg)))
      throw new Error(
        `${flag} is managed by Miracle; remove it from the profile command`,
      );
    if (provider === "codex" && mappings[flag]) {
      const value = equal >= 0 ? arg.slice(equal + 1) : parsed.args[i++];
      if (!value || value.startsWith("-"))
        throw new Error(`${flag} needs a value`);
      args.push("-c", mappings[flag] + "=" + JSON.stringify(value));
    } else if (
      provider === "codex" &&
      arg === "--dangerously-bypass-approvals-and-sandbox"
    )
      args.push(
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
      );
    else if (provider === "codex" && arg === "--search")
      args.push("-c", 'web_search="live"');
    else if (provider === "codex" && arg === "--oss")
      throw new Error(
        "Use --local-provider with an explicit provider instead of --oss in Miracle",
      );
    else if (
      provider === "codex" &&
      [
        "-p",
        "--profile",
        "--add-dir",
        "--no-alt-screen",
        "--dangerously-bypass-hook-trust",
      ].includes(flag)
    )
      throw new Error(
        `${flag} is not supported by the app-server transport; use equivalent -c configuration or a wrapper`,
      );
    else {
      if (provider === "codex" && (flag === "-c" || flag === "--config")) {
        const config = equal >= 0 ? arg.slice(equal + 1) : parsed.args[i++];
        if (!config || !config.includes("="))
          throw new Error(`${flag} needs key=value`);
        if (
          /^(?:cwd(?:\.|$)|mcp_servers(?:$|\.miracle(?:\.|$)))/.test(
            config.slice(0, config.indexOf("=")).trim(),
          )
        )
          throw new Error("Miracle manages cwd and mcp_servers.miracle");
        args.push("-c", config);
      } else args.push(arg);
    }
  }
  if (provider === "claude")
    args.push(
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "mcp__miracle__permission_prompt",
    );
  const preview = [
    ...Object.keys(parsed.env).map((key) => key + "=<redacted>"),
    quoteArg(parsed.executable),
    ...args.map((arg, index) => {
      const assignment = arg.indexOf("=");
      if (
        assignment >= 0 &&
        /TOKEN|SECRET|PASSWORD|API.?KEY/i.test(arg.slice(0, assignment))
      )
        return quoteArg(arg.slice(0, assignment) + "=<redacted>");
      if (
        index > 0 &&
        /^--?(?:api-key|token|password|secret)$/i.test(args[index - 1]!)
      )
        return "<redacted>";
      return quoteArg(arg);
    }),
  ].join(" ");
  return { ...parsed, prefixArgs, args, preview };
}
