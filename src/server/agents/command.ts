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
  return { executable, args: words, env };
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
  const args: string[] = [];
  // Wrapper scripts may take positional arguments before native CLI flags.
  let i = 0;
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
        "--",
      ].includes(value)
    )
      throw new Error(
        "Miracle manages the provider subcommand; configure the base CLI command",
      );
    args.push(value);
  }
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
  return { ...parsed, args, preview };
}
