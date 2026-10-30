import { randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  open,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const version = JSON.parse(
  await readFile(
    join(
      import.meta.url.endsWith(".ts") ? sourceRoot : packageRoot,
      "package.json",
    ),
    "utf8",
  ),
).version as string;
interface State {
  token: string;
  port: number;
  pid: number;
  dataDir: string;
  version: string;
}
function installRoot() {
  if (process.env.MIRACLE_INSTALL_ROOT)
    return resolve(process.env.MIRACLE_INSTALL_ROOT);
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Miracle");
  if (process.platform === "win32")
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Miracle",
    );
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "miracle",
  );
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
type ControlState = "running" | "stopped" | "unknown";
async function control(
  state: State,
  action: "status" | "stop",
): Promise<ControlState> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${state.port}/api/local/control`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      },
    );
    return response.ok &&
      ((await response.json()) as { ok?: boolean }).ok === true
      ? "running"
      : "unknown";
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code ===
      "ECONNREFUSED"
      ? "stopped"
      : "unknown";
  }
}
async function storageStopped(dataDir: string) {
  try {
    const { assertWorkspaceStopped } = await import("./maintenance.js");
    await assertWorkspaceStopped(dataDir);
    return true;
  } catch {
    return false;
  }
}
function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => console.error("Open the URL above in your browser."));
  child.unref();
}
let startupLock: string | undefined;
async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || "open";
  if (["--version", "version", "-v"].includes(command))
    return console.log(version);
  if (["--help", "help", "-h"].includes(command))
    return console.log(
      `Miracle ${version}\nUsage: miracle [open|start|serve|stop|status|backup DIRECTORY|restore DIRECTORY]\n  --port N          Local port (default 3001)\n  --data-dir PATH   Workspace directory\n  status --json     Machine-readable state\n  --version         Installed version\n`,
    );
  if (
    !["open", "start", "serve", "stop", "status", "backup", "restore"].includes(
      command,
    )
  )
    throw new Error(`Unknown command: ${command}. Run miracle --help.`);
  let portArgument: string | undefined,
    dataArgument: string | undefined,
    json = false;
  const positional: string[] = [];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--port" || arg === "--data-dir") {
      const value = args.shift();
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);
      if (arg === "--port") portArgument = value;
      else dataArgument = value;
    } else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== (["backup", "restore"].includes(command) ? 1 : 0))
    throw new Error(`Invalid arguments for ${command}. Run miracle --help.`);
  const root = installRoot();
  const config = await import("./config.js");
  const dataDir = resolve(
    dataArgument ||
      config.resolveDataDir({
        ...process.env,
        MIRACLE_DATA_DIR: process.env.MIRACLE_DATA_DIR || join(root, "data"),
      }),
  );
  const configuredPort = config.resolvePort({
    ...process.env,
    ...(portArgument ? { PORT: portArgument } : {}),
  });
  const stateFile = join(
    root,
    "run",
    createHash("sha256").update(dataDir).digest("hex") + ".json",
  );
  let state: State | undefined;
  try {
    const candidate = JSON.parse(await readFile(stateFile, "utf8")) as State;
    if (
      candidate.dataDir !== dataDir ||
      !Number.isInteger(candidate.port) ||
      candidate.port < 1 ||
      candidate.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(candidate.token)
    )
      throw new Error("invalid");
    state = candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Invalid private runtime state; inspect the installation run directory.",
      );
  }
  let health: ControlState = state ? await control(state, "status") : "stopped";
  if (health === "stopped" && !(await storageStopped(dataDir)))
    health = "unknown";
  const running = health === "running";
  if (command === "status") {
    const result = {
      status: health === "unknown" ? "error" : health,
      ...(running
        ? {
            port: state!.port,
            pid: state!.pid,
            dataDir,
            version: state!.version,
            url: `http://127.0.0.1:${state!.port}`,
          }
        : { dataDir }),
    };
    console.log(
      json
        ? JSON.stringify(result)
        : `${result.status}${running ? `: http://127.0.0.1:${state!.port}` : ""}`,
    );
    if (health === "unknown") process.exitCode = 1;
    return;
  }
  if (health === "unknown")
    throw new Error(
      "Cannot verify whether Miracle is stopped. Runtime state retained; retry when the local service responds.",
    );
  if (command === "stop") {
    if (!running) {
      if (state) await rm(stateFile, { force: true });
      return console.log("Miracle is stopped.");
    }
    if ((await control(state!, "stop")) !== "running")
      throw new Error(
        "Could not authenticate graceful stop. No process was killed.",
      );
    let uncertainAttempts = 0;
    for (let i = 0; i < 200; i++) {
      const current = await control(state!, "status");
      if (current === "unknown") {
        uncertainAttempts++;
        if (uncertainAttempts >= 3)
          throw new Error(
            "Cannot verify graceful shutdown. Runtime state retained; no process was killed.",
          );
      } else uncertainAttempts = 0;
      if (current === "stopped" && (await storageStopped(dataDir))) {
        await rm(stateFile, { force: true });
        return console.log("Miracle stopped.");
      }
      await pause(100);
    }
    throw new Error(
      "Timed out waiting for graceful shutdown. No process was killed.",
    );
  }
  if (command === "backup" || command === "restore") {
    if (running) throw new Error("Stop Miracle before backup or restore.");
    const { backupWorkspace, restoreWorkspace } =
      await import("./maintenance.js");
    if (command === "backup")
      await backupWorkspace(dataDir, resolve(positional[0]!));
    else await restoreWorkspace(resolve(positional[0]!), dataDir);
    return console.log(
      `${command === "backup" ? "Backup" : "Restore"} complete.`,
    );
  }
  if (running) {
    if (portArgument && state!.port !== configuredPort)
      throw new Error(
        `Miracle is already running on port ${state!.port}; stop it before changing port.`,
      );
    const url = `http://127.0.0.1:${state!.port}`;
    console.log(url);
    if (command === "open") openBrowser(url);
    if (command === "serve") throw new Error("Miracle is already running.");
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".install-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Installation or startup is already in progress. Retry after it finishes.",
    );
  }
  startupLock = lock;
  await mkdir(join(root, "run"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "run"), 0o700);
  await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 });
  const logPath = join(root, "logs", "miracle.log");
  const log = await open(logPath, "a", 0o600);
  await log.chmod(0o600);
  const token = randomBytes(32).toString("hex");
  const index = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js",
      import.meta.url,
    ),
  );
  const child = spawn(
    process.execPath,
    [...(import.meta.url.endsWith(".ts") ? process.execArgv : []), index],
    {
      detached: command !== "serve",
      stdio: command === "serve" ? "inherit" : ["ignore", log.fd, log.fd],
      cwd: root,
      env: {
        ...process.env,
        MIRACLE_DATA_DIR: dataDir,
        PORT: String(configuredPort),
        APP_ORIGIN: `http://127.0.0.1:${configuredPort}`,
        MIRACLE_CONTROL_TOKEN: token,
      },
    },
  );
  await log.close();
  let childError: Error | undefined;
  child.on("error", (error) => {
    childError = error;
  });
  const candidate: State = {
    token,
    port: configuredPort,
    pid: child.pid!,
    dataDir,
    version,
  };
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (childError || child.exitCode !== null) break;
    if ((await control(candidate, "status")) === "running") {
      ready = true;
      break;
    }
    await pause(100);
  }
  if (!ready) {
    child.unref();
    // This token identifies only the child we created. Never use a stored PID.
    await control(candidate, "stop");
    const detail = (await readFile(logPath, "utf8"))
      .slice(-2000)
      .replaceAll(token, "[redacted]");
    throw new Error(
      `Miracle could not start on port ${configuredPort}. The port may be occupied or workspace already open. See ${logPath}.\n${detail}`,
    );
  }
  const temporary = `${stateFile}.${token}.tmp`;
  await writeFile(temporary, JSON.stringify(candidate) + "\n", { mode: 0o600 });
  await rename(temporary, stateFile);
  await rm(startupLock!, { recursive: true, force: true });
  startupLock = undefined;
  const url = `http://127.0.0.1:${configuredPort}`;
  console.log(url);
  if (command === "serve") {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        void control(candidate, "stop");
      });
    await new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
    const current = JSON.parse(
      await readFile(stateFile, "utf8").catch(() => "{}"),
    ) as Partial<State>;
    if (current.token === token) await rm(stateFile, { force: true });
  } else {
    child.unref();
    if (command === "open") openBrowser(url);
  }
}
main()
  .finally(async () => {
    if (startupLock) await rm(startupLock, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Miracle command failed",
    );
    process.exitCode = 1;
  });
