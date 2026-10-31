import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  chmod,
  stat,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { Agent, fetch as packageFetch } from "undici";

if (!["darwin", "linux"].includes(process.platform))
  throw new Error(
    "Miracle supports macOS and Linux. On Windows, run the Linux installer inside WSL2.",
  );

const [sourceArgument, rootArgument, binArgument] = process.argv.slice(2);
if (!sourceArgument || !rootArgument)
  throw new Error(
    "Usage: bundled-node install.mjs extracted-payload install-root [bin-directory]",
  );
const source = resolve(sourceArgument),
  root = resolve(rootArgument);
const bin = resolve(binArgument || join(homedir(), ".local", "bin"));
const version = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
).version;
function versionParts(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    throw new Error(
      "Invalid installation version; inspect the version pointer before retrying.",
    );
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger))
    throw new Error("Invalid installation version.");
  return parts;
}
const targetVersion = versionParts(version);
const nodeAt = (dir) => join(dir, "runtime/bin/node");
const cliAt = (dir) => join(dir, "dist/server/server/cli.js");
function validate(dir) {
  const result = spawnSync(nodeAt(dir), [cliAt(dir), "--version"], {
    encoding: "utf8",
    env: { ...process.env, MIRACLE_INSTALL_ROOT: root },
    timeout: 15000,
  });
  if (result.status !== 0 || result.stdout.trim() !== version)
    throw new Error(
      "Staged application validation failed; active installation unchanged.",
    );
}
validate(source);
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(join(root, "versions"), { recursive: true, mode: 0o700 });
// Serialize installation operations. Never delete an unexplained lock after a crash.
const lock = join(root, ".install-lock");
try {
  await mkdir(lock, { mode: 0o700 });
} catch {
  throw new Error(
    "Another installation is in progress. If an installer was interrupted, inspect and remove .install-lock before retrying.",
  );
}
async function assertStoppedStorage(dataDir) {
  const exists = await stat(join(dataDir, "miracle.sqlite")).then(
    () => true,
    (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
  );
  if (!exists) return;
  const { assertWorkspaceStopped } = await import(
    pathToFileURL(join(source, "dist/server/server/maintenance.js")).href
  );
  await assertWorkspaceStopped(dataDir);
}
let staging;
// Use the bundled dependency's dispatcher, not Node 24's shared undici 7 pool.
const controlAgent = new Agent({ allowH2: false });
try {
  // Re-read under the same lock that protects activation. An update may have
  // spent minutes downloading while a newer release became active.
  const activeVersion = await readFile(
    join(root, "current-version"),
    "utf8",
  ).then(
    (value) => value.trim(),
    (error) => (error.code === "ENOENT" ? undefined : Promise.reject(error)),
  );
  if (activeVersion !== undefined) {
    const active = versionParts(activeVersion);
    for (let index = 0; index < 3; index++) {
      if (targetVersion[index] < active[index])
        throw new Error(
          `Refusing to downgrade Miracle ${activeVersion} to ${version}; running projects and the active installation are unchanged.`,
        );
      if (targetVersion[index] > active[index]) break;
    }
  }
  const dataDirectories = new Set([join(root, "data")]);
  const legacyWorkspaces = new Map();
  // Authenticate every saved instance, including custom data directories. A PID is never a signal target.
  for (const name of await readdir(join(root, "run")).catch((error) =>
    error.code === "ENOENT" ? [] : Promise.reject(error),
  )) {
    if (!name.endsWith(".json")) continue;
    const state = JSON.parse(await readFile(join(root, "run", name), "utf8"));
    if (
      !Number.isInteger(state.port) ||
      state.port < 1 ||
      state.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(state.token) ||
      typeof state.dataDir !== "string"
    )
      throw new Error("Invalid runtime state; inspect it before installation.");
    dataDirectories.add(state.dataDir);
    // Old releases used one global workspace and browser drafts tied to its port.
    // Keep the reopen address before removing stopped runtime registrations.
    if (!state.projectRoot) legacyWorkspaces.set(state.dataDir, state.port);
    const control = async (action, allowShutdownDisconnect = false) => {
      try {
        const response = await packageFetch(
          `http://127.0.0.1:${state.port}/api/local/control`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${state.token}`,
              "content-type": "application/json",
              connection: "close",
            },
            body: JSON.stringify({ action }),
            signal: AbortSignal.timeout(1500),
            redirect: "error",
            dispatcher: controlAgent,
          },
        );
        if (!response.ok || (await response.json()).ok !== true)
          throw new Error(
            "Cannot authenticate saved runtime state; inspect it before installation.",
          );
        return "running";
      } catch (error) {
        if (error.cause?.code === "ECONNREFUSED") return "stopped";
        // A listener may reset a pooled/closing socket during graceful shutdown.
        // It is still unknown until a fresh request is refused and SQLite releases.
        if (
          allowShutdownDisconnect &&
          ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"].includes(error.cause?.code)
        )
          return "unknown";
        throw new Error(
          "Cannot authenticate or verify saved runtime state; active installation unchanged.",
          { cause: error },
        );
      }
    };
    if ((await control("status")) === "running") {
      await control("stop");
      let stopped = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await control("status", true)) === "stopped") {
          stopped = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!stopped)
        throw new Error(
          "Timed out waiting for project shutdown; active installation unchanged.",
        );
    }
    // A refused listener alone is insufficient while SQLite is still draining.
    for (let attempt = 0; ; attempt++) {
      try {
        await assertStoppedStorage(state.dataDir);
        break;
      } catch (error) {
        if (attempt >= 199 || error.cause?.errcode !== 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await rm(join(root, "run", name), { force: true });
  }
  for (const dataDir of dataDirectories) await assertStoppedStorage(dataDir);
  if (
    !legacyWorkspaces.has(join(root, "data")) &&
    (await stat(join(root, "data", "miracle.sqlite")).then(
      () => true,
      (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    ))
  )
    legacyWorkspaces.set(join(root, "data"), 3001);
  const destination = join(root, "versions", version);
  if (
    await stat(destination).then(
      () => true,
      (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    )
  )
    validate(destination);
  else {
    staging = join(root, "versions", `.stage-${version}-${process.pid}`);
    await cp(source, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    validate(staging);
    await rename(staging, destination);
    staging = undefined;
  }
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const launcher = `#!/bin/sh\nset -eu\nMIRACLE_INSTALL_ROOT=${quote(root)}\nMIRACLE_BIN_DIR=${quote(bin)}\nexport MIRACLE_INSTALL_ROOT MIRACLE_BIN_DIR\nIFS= read -r miracle_version < "$MIRACLE_INSTALL_ROOT/current-version"\ncase "$miracle_version" in *[!0-9.]*|'') echo 'Invalid Miracle version pointer' >&2; exit 1;; esac\nexec "$MIRACLE_INSTALL_ROOT/versions/$miracle_version/runtime/bin/node" "$MIRACLE_INSTALL_ROOT/versions/$miracle_version/dist/server/server/cli.js" "$@"\n`;
  await writeFile(join(bin, ".miracle.tmp"), launcher, { mode: 0o755 });
  await chmod(join(bin, ".miracle.tmp"), 0o755);
  await rename(join(bin, ".miracle.tmp"), join(bin, "miracle"));

  const installation = join(root, `.installation-${process.pid}.json`);
  await writeFile(
    installation,
    JSON.stringify({ version: 1, binDir: bin }) + "\n",
    { mode: 0o600 },
  );
  await rename(installation, join(root, "installation.json"));

  const pointer = join(root, `.current-version-${process.pid}`);
  await writeFile(pointer, version + "\n", { mode: 0o600 });
  await rename(pointer, join(root, "current-version"));
  console.log(
    `Miracle ${version} installed.\nCommand: ${join(bin, "miracle")}\nAdd ${bin} to PATH if it is not already present.\nNew project data: .miracle in the current project directory`,
  );
  for (const [dataDir, port] of legacyWorkspaces) {
    console.log(
      `\nExisting workspace preserved: ${dataDir}\nOpen it at its previous browser address to import SQL drafts:\n  ${quote(join(bin, "miracle"))} open --data-dir ${quote(dataDir)} --port ${port}\nIf you used a different port, use that original port instead. Keep the old directory until you verify the migration.`,
    );
  }
} finally {
  await controlAgent.destroy();
  if (staging) await rm(staging, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
