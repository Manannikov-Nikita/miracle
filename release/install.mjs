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
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Invalid package version");
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
try {
  const dataDirectories = new Set([join(root, "data")]);
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
    let response;
    try {
      response = await fetch(
        `http://127.0.0.1:${state.port}/api/local/control`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${state.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "status" }),
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        },
      );
    } catch (error) {
      if (!["ECONNREFUSED"].includes(error.cause?.code))
        throw new Error(
          "Cannot verify whether Miracle is stopped. Retry when local networking is available.",
        );
      continue;
    }
    if (response.ok && (await response.json()).ok === true)
      throw new Error("Stop Miracle before installing: miracle stop");
    throw new Error(
      "Cannot authenticate saved runtime state; inspect it before installation.",
    );
  }
  for (const dataDir of dataDirectories) await assertStoppedStorage(dataDir);
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
  const launcher = `#!/bin/sh\nset -eu\nMIRACLE_INSTALL_ROOT=${quote(root)}\nexport MIRACLE_INSTALL_ROOT\nIFS= read -r miracle_version < "$MIRACLE_INSTALL_ROOT/current-version"\ncase "$miracle_version" in *[!0-9.]*|'') echo 'Invalid Miracle version pointer' >&2; exit 1;; esac\nexec "$MIRACLE_INSTALL_ROOT/versions/$miracle_version/runtime/bin/node" "$MIRACLE_INSTALL_ROOT/versions/$miracle_version/dist/server/server/cli.js" "$@"\n`;
  await writeFile(join(bin, ".miracle.tmp"), launcher, { mode: 0o755 });
  await chmod(join(bin, ".miracle.tmp"), 0o755);
  await rename(join(bin, ".miracle.tmp"), join(bin, "miracle"));

  const pointer = join(root, `.current-version-${process.pid}`);
  await writeFile(pointer, version + "\n", { mode: 0o600 });
  await rename(pointer, join(root, "current-version"));
  console.log(
    `Miracle ${version} installed.\nRun: ${join(bin, "miracle")}\nAdd ${bin} to PATH if it is not already present.\nData: ${join(root, "data")}`,
  );
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
