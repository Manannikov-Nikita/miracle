import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  buildAgentCommand,
  childAgentEnvironment,
  parseAgentCommand,
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
    let pending = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) {
        onError(
          agentError(
            "Provider output exceeded the 4 MiB protocol message limit",
          ),
        );
        void this.stop();
        return;
      }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (!message || typeof message !== "object" || Array.isArray(message))
            throw new Error();
          onMessage(message);
        } catch {
          onError(
            agentError(
              "Provider returned invalid structured JSON; check the configured CLI command",
            ),
          );
          void this.stop();
          return;
        }
      }
    });
    this.child.stdout.once("end", () => {
      if (pending.trim())
        onError(
          agentError("Provider closed with an incomplete protocol message"),
        );
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
  stop(initial: NodeJS.Signals = "SIGTERM"): Promise<void> {
    return (this.stopPromise ??= (async () => {
      if (!this.alive) return;
      this.signal(initial);
      await Promise.race([this.closed, delay(1000)]);
      if (this.alive && initial !== "SIGTERM") {
        this.signal("SIGTERM");
        await Promise.race([this.closed, delay(1000)]);
      }
      if (this.alive) {
        this.signal("SIGKILL");
        await Promise.race([this.closed, delay(1000)]);
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
        )}`,
      );
    return output;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted || timedOut) await transport.stop().catch(() => {});
  }
}
export async function checkAgentCommand(
  provider: AgentProvider,
  command: string,
  cwd: string,
  signal?: AbortSignal,
) {
  const built = buildAgentCommand(provider, command),
    parsed = parseAgentCommand(command);
  const env = childAgentEnvironment(process.env, parsed.env);
  // Keep wrapper arguments, but omit user flags for generic version/help capability probes.
  const prefix: string[] = [];
  for (const arg of parsed.args) {
    if (arg.startsWith("-")) break;
    prefix.push(arg);
  }
  const version = (
    await probe(parsed.executable, [...prefix, "--version"], cwd, env, signal)
  ).trim();
  if (!version || version.length > 500)
    throw agentError("The configured executable did not report a CLI version");
  const help = await probe(
    parsed.executable,
    [...prefix, ...(provider === "codex" ? ["app-server"] : []), "--help"],
    cwd,
    env,
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
      `Installed ${provider} CLI (${version}) does not support ${missing.join(", ")}; update the CLI or configure a compatible wrapper`,
    );
  return {
    version,
    commandPreview: built.preview,
    executable: built.executable,
  };
}
