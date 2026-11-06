import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  buildAgentCommand,
  childAgentEnvironment,
  type AgentProvider,
} from "./command.js";

export function agentError(
  message: string,
  code?: string,
): Error & { code?: string } {
  return Object.assign(new Error(message), code ? { code } : {});
}
export function sanitizeAgentText(
  text: string,
  secrets: string[] = [],
): string {
  for (const secret of secrets)
    if (secret) text = text.replaceAll(secret, "<redacted>");
  return text.replace(/Bearer\s+[^\s"',}]+/gi, "Bearer <redacted>");
}
export function sanitizeAgentValue<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return sanitizeAgentText(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((item) => sanitizeAgentValue(item, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeAgentValue(item, secrets),
      ]),
    ) as T;
  return value;
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export class AgentTransport {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>;
  private alive = true;
  private stopPromise?: Promise<void>;
  constructor(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly maxMessageBytes = 4 * 1024 * 1024,
  ) {
    this.child = spawn(executable, args, {
      cwd,
      env,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child.stdin.on("error", () => {});
    this.closed = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.alive = false;
        resolve({ code: null, signal: null, error });
      });
      this.child.once("close", (code, signal) => {
        this.alive = false;
        resolve({ code, signal });
      });
    });
  }
  send(value: unknown) {
    if (this.alive && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  json(onMessage: (message: any) => void, onError: (error: Error) => void) {
    let parts: string[] = [];
    let pendingBytes = 0;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      parts = [];
      pendingBytes = 0;
      onError(error);
      void this.stop();
    };
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (failed) return;
      let offset = 0;
      while (offset < chunk.length) {
        // Scan and count only new input; a large line may span thousands of reads.
        const newline = chunk.indexOf("\n", offset);
        const end = newline < 0 ? chunk.length : newline + 1;
        const part = chunk.slice(offset, end);
        pendingBytes += Buffer.byteLength(part);
        if (pendingBytes > this.maxMessageBytes) {
          fail(
            agentError(
              `Provider output exceeded the ${this.maxMessageBytes / 1024 / 1024} MiB protocol message limit`,
              "AGENT_PROTOCOL_MESSAGE_LIMIT",
            ),
          );
          return;
        }
        parts.push(part);
        if (newline < 0) return;
        const line = parts.join("").slice(0, -1);
        parts = [];
        pendingBytes = 0;
        offset = end;
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (!message || typeof message !== "object" || Array.isArray(message))
            throw new Error();
          onMessage(message);
        } catch {
          fail(
            agentError(
              "Provider returned invalid structured JSON; check the configured CLI command",
            ),
          );
          return;
        }
      }
    });
    this.child.stdout.once("end", () => {
      if (!failed && parts.join("").trim())
        fail(agentError("Provider closed with an incomplete protocol message"));
    });
  }
  signal(signal: NodeJS.Signals) {
    if (!this.alive || !this.child.pid) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  private async signalAndWait(signal: NodeJS.Signals) {
    let permissionError: unknown;
    try {
      this.signal(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      permissionError = error;
    }
    await Promise.race([this.closed, delay(1000)]);
    if (!permissionError) return;
    // macOS can report EPERM for a group containing only an exiting zombie.
    // Confirm both pipe closure and group absence; close alone can leave descendants.
    if (!this.alive && this.child.pid) {
      try {
        process.kill(
          process.platform === "win32" ? this.child.pid : -this.child.pid,
          0,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    throw permissionError;
  }
  stop(initial: NodeJS.Signals = "SIGTERM"): Promise<void> {
    return (this.stopPromise ??= (async () => {
      if (!this.alive) return;
      await this.signalAndWait(initial);
      if (this.alive && initial !== "SIGTERM") {
        await this.signalAndWait("SIGTERM");
      }
      if (this.alive) {
        await this.signalAndWait("SIGKILL");
      }
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    })());
  }
}

async function probe(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  compatibilityHint: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted)
    throw agentError("Agent turn stopped", "AGENT_CANCELLED");
  const transport = new AgentTransport(executable, args, cwd, env);
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
  const abort = () => {
    interrupt(agentError("Agent turn stopped", "AGENT_CANCELLED"));
    void transport.stop().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let output = "",
    stderr = "";
  transport.child.stdout.setEncoding("utf8");
  transport.child.stderr.setEncoding("utf8");
  transport.child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-128 * 1024);
  });
  transport.child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    interrupt(
      agentError(
        "Agent capability check timed out; verify the CLI command in a terminal",
      ),
    );
    void transport.stop().catch(() => {});
  }, 8000);
  try {
    const result = await Promise.race([transport.closed, interrupted]);
    if (signal?.aborted)
      throw agentError("Agent turn stopped", "AGENT_CANCELLED");
    if (result.error)
      throw agentError(
        `Unable to launch the agent executable: ${(result.error as NodeJS.ErrnoException).code || result.error.message}`,
      );
    if (timedOut)
      throw agentError(
        "Agent capability check timed out; verify the CLI command in a terminal",
      );
    if (result.code !== 0)
      throw agentError(
        `Agent capability check failed (${result.code}): ${sanitizeAgentText(
          stderr,
          Object.values(env).filter((v): v is string => !!v && v.length > 12),
        )}\n${compatibilityHint}`,
      );
    return output;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted || timedOut) await transport.stop().catch(() => {});
  }
}

/** Load settings without creating a thread, invoking a model, or running tools. */
async function checkCodexConfiguration(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  if (signal?.aborted)
    throw agentError("Agent turn stopped", "AGENT_CANCELLED");
  const transport = new AgentTransport(executable, args, cwd, env);
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        value && (/TOKEN|KEY|PASSWORD|SECRET/i.test(key) || value.length > 12),
    )
    .map(([, value]) => value!);
  for (const [index, arg] of args.entries()) {
    const equal = arg.indexOf("=");
    const key = equal >= 0 ? arg.slice(0, equal) : args[index - 1];
    if (!key || !/TOKEN|SECRET|PASSWORD|API.?KEY/i.test(key)) continue;
    const value = equal >= 0 ? arg.slice(equal + 1).trim() : arg;
    if (!value) continue;
    secrets.push(value);
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded === "string") secrets.push(decoded);
    } catch {
      if (value.startsWith("'") && value.endsWith("'"))
        secrets.push(value.slice(1, -1));
    }
  }
  const configurationError = (detail: string) =>
    Object.assign(
      agentError(
        "Не удалось проверить конфигурацию Codex. Проверьте совместимость версии CLI с настройками config.toml и командой профиля Miracle. " +
          "Укажите совместимый CLI в профиле или исправьте неподдерживаемую настройку.\n" +
          sanitizeAgentText(detail, secrets),
        "AGENT_CONFIGURATION_INVALID",
      ),
      { statusCode: 400 },
    );
  let stderr = "";
  transport.child.stderr.setEncoding("utf8");
  transport.child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  let settled = false;
  let expectedId = 1;
  let finish!: (error?: Error) => void;
  const checked = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
  });
  const abort = () =>
    finish(agentError("Agent turn stopped", "AGENT_CANCELLED"));
  const timeout = setTimeout(
    () => finish(configurationError("Codex configuration check timed out")),
    8000,
  );
  signal?.addEventListener("abort", abort, { once: true });
  transport.json(
    (message) => {
      if (settled || message.id !== expectedId || message.method) return;
      if (message.error) {
        finish(
          configurationError(
            String(message.error.message || "Codex request failed"),
          ),
        );
        return;
      }
      if (expectedId === 1) {
        if (typeof message.result?.userAgent !== "string") {
          finish(
            configurationError(
              "Codex initialization did not return a compatible protocol response",
            ),
          );
          return;
        }
        expectedId = 2;
        transport.send({ method: "initialized", params: {} });
        transport.send({
          id: 2,
          method: "config/read",
          params: { includeLayers: false, cwd },
        });
      } else {
        const config = message.result?.config;
        finish(
          config && typeof config === "object" && !Array.isArray(config)
            ? undefined
            : configurationError(
                "Codex config/read did not return a compatible configuration response",
              ),
        );
      }
    },
    (error) => finish(configurationError(error.message)),
  );
  void transport.closed.then((result) => {
    finish(
      configurationError(
        result.error
          ? `Unable to launch Codex: ${result.error.message}`
          : `Codex exited during configuration check (${result.code ?? result.signal}): ${stderr}`,
      ),
    );
  });
  try {
    if (signal?.aborted) abort();
    else
      transport.send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "miracle", title: "Miracle", version: "0.2.1" },
          capabilities: { experimentalApi: false },
        },
      });
    await checked;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await transport.stop();
  }
}

export async function checkAgentCommand(
  provider: AgentProvider,
  command: string,
  cwd: string,
  signal?: AbortSignal,
) {
  const built = buildAgentCommand(provider, command);
  const env = childAgentEnvironment(process.env, built.env);
  const providerName = provider === "claude" ? "Claude Code" : "Codex";
  const protocol = provider === "claude" ? "stream-json" : "app-server";
  const compatibilityHint =
    `Miracle requires the ${providerName} ${protocol} structured protocol. ` +
    `A command that rejects the managed protocol arguments is incompatible with this chat. ` +
    `Use a compatible ${providerName} CLI directly or a wrapper that forwards all managed protocol arguments.`;
  // Keep the complete launcher for every check. Help checks protocol flags;
  // Codex only loads and validates its effective settings through config/read.
  const version = (
    await probe(
      built.executable,
      [...built.prefixArgs, "--version"],
      cwd,
      env,
      compatibilityHint,
      signal,
    )
  ).trim();
  if (!version || version.length > 500)
    throw agentError("The configured executable did not report a CLI version");
  const help = await probe(
    built.executable,
    [...built.args, "--help"],
    cwd,
    env,
    compatibilityHint,
    signal,
  );
  const required =
    provider === "codex"
      ? ["--stdio"]
      : [
          "--input-format",
          "--output-format",
          "--include-partial-messages",
          "--permission-prompt-tool",
          "--mcp-config",
          "--resume",
        ];
  const missing = required.filter((flag) => !help.includes(flag));
  if (missing.length)
    throw agentError(
      `The configured ${providerName} command (${version}) does not advertise ${missing.join(", ")}. ${compatibilityHint}`,
    );
  if (provider === "codex")
    await checkCodexConfiguration(
      built.executable,
      built.args,
      cwd,
      env,
      signal,
    );
  return {
    version,
    commandPreview: built.preview,
    executable: built.executable,
  };
}
