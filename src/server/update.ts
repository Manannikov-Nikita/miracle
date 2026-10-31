import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  createHttpTransport,
  type HttpRequestOptions,
  type HttpResponse,
} from "./http-transport.js";

const repository = "Manannikov-Nikita/miracle";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function versionParts(version: string) {
  if (!versionPattern.test(version))
    throw new Error("Invalid release version: expected X.Y.Z.");
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger))
    throw new Error("Invalid release version.");
  return parts;
}
function compareVersions(left: string, right: string) {
  const a = versionParts(left),
    b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
export function parseUpdateArguments(args: string[]) {
  let check = false,
    to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--check" && !check) check = true;
    else if (value === "--to" && to === undefined) {
      to = args[++i];
      if (!to) throw new Error("--to needs a release version X.Y.Z.");
      versionParts(to);
    } else
      throw new Error(
        `Unknown update option: ${value}. Use miracle update [--check] [--to X.Y.Z].`,
      );
  }
  return { check, to };
}
interface UpdateInput {
  installRoot: string;
  packageRoot: string;
  currentVersion: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
interface UpdateDependencies {
  fetch?: (url: string, options?: HttpRequestOptions) => Promise<HttpResponse>;
  run?: (installer: string, env: NodeJS.ProcessEnv) => Promise<void>;
  log?: (message: string) => void;
}
async function runInstaller(installer: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn("/bin/sh", [installer], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolveRun()
        : reject(
            new Error(
              `Miracle installer failed (${signal || `exit ${code}`}); review the message above before retrying.`,
            ),
          ),
    );
  });
}
async function responseText(response: HttpResponse, limit: number) {
  if (!response.ok)
    throw new Error(
      `Release download failed (HTTP ${response.status}); installation unchanged.`,
    );
  if (!response.body) throw new Error("Release response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit)
        throw new Error(
          "Release response is too large; installation unchanged.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function updateInstallation(
  input: UpdateInput,
  dependencies: UpdateDependencies = {},
) {
  if (dependencies.fetch)
    return performUpdate(
      input,
      dependencies as UpdateDependencies & {
        fetch: NonNullable<UpdateDependencies["fetch"]>;
      },
    );
  const transport = createHttpTransport();
  try {
    return await performUpdate(input, {
      ...dependencies,
      fetch: transport.request,
    });
  } finally {
    await transport.close();
  }
}
async function performUpdate(
  input: UpdateInput,
  dependencies: UpdateDependencies & {
    fetch: NonNullable<UpdateDependencies["fetch"]>;
  },
) {
  const { check, to } = parseUpdateArguments(input.args);
  const env = input.env || process.env;
  const fetchRelease = dependencies.fetch;
  const log = dependencies.log || console.log;
  const root = resolve(input.installRoot);
  // Never let a source checkout or an old executable update an unrelated install.
  try {
    const active = (
      await readFile(join(root, "current-version"), "utf8")
    ).trim();
    if (
      active !== input.currentVersion ||
      (await realpath(input.packageRoot)) !==
        (await realpath(join(root, "versions", active)))
    )
      throw new Error("not active");
  } catch {
    throw new Error(
      "Run miracle update through the active installed miracle command. Source checkouts use the release installer.",
    );
  }
  const metadataUrl = `https://api.github.com/repos/${repository}/releases/${to ? `tags/v${to}` : "latest"}`;
  const release = JSON.parse(
    await responseText(
      await fetchRelease(metadataUrl, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `Miracle/${input.currentVersion}`,
        },
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      }),
      1_000_000,
    ),
  ) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string" ||
    !release.tag_name.startsWith("v")
  )
    throw new Error("Only published stable Miracle releases can be installed.");
  const target = release.tag_name.slice(1);
  versionParts(target);
  if (to && target !== to)
    throw new Error("Release metadata does not match the requested version.");
  const comparison = compareVersions(target, input.currentVersion);
  if (comparison < 0) {
    if (check)
      return log(
        `Miracle ${input.currentVersion} is newer than the published release ${target}.`,
      );
    throw new Error(
      `Refusing to downgrade Miracle ${input.currentVersion} to ${target}; older releases may not read current project data.`,
    );
  }
  if (comparison === 0)
    return log(`Miracle ${input.currentVersion} is already up to date.`);
  if (check)
    return log(
      `Miracle ${target} is available (installed: ${input.currentVersion}). Run miracle update to install it.`,
    );
  let binDir = env.MIRACLE_BIN_DIR || join(homedir(), ".local", "bin");
  try {
    const metadata = JSON.parse(
      await readFile(join(root, "installation.json"), "utf8"),
    ) as { version?: unknown; binDir?: unknown };
    if (
      metadata.version !== 1 ||
      typeof metadata.binDir !== "string" ||
      !isAbsolute(metadata.binDir)
    )
      throw new Error(
        "Invalid installation metadata; repeat the official installer with MIRACLE_BIN_DIR set to your launcher directory.",
      );
    binDir = metadata.binDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const installerUrl = `https://github.com/${repository}/releases/download/v${target}/install.sh`;
  const response = await fetchRelease(installerUrl, {
    signal: AbortSignal.timeout(30000),
  });
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (
      finalUrl.protocol !== "https:" ||
      !["github.com", "release-assets.githubusercontent.com"].includes(
        finalUrl.hostname,
      )
    )
      throw new Error(
        "Unexpected release download destination; installation unchanged.",
      );
  }
  const script = await responseText(response, 1_000_000);
  if (
    !script.startsWith("#!/bin/sh\n") ||
    !script.split("\n").includes(`VERSION='${target}'`) ||
    !script.split("\n").includes(`REPOSITORY='${repository}'`)
  )
    throw new Error(
      "Downloaded installer does not match the requested Miracle release; installation unchanged.",
    );
  const temporary = await mkdtemp(join(tmpdir(), "miracle-update-"));
  try {
    const installer = join(temporary, "install.sh");
    await writeFile(installer, script, { mode: 0o600 });
    const installEnv: NodeJS.ProcessEnv = {
      ...env,
      MIRACLE_INSTALL_ROOT: root,
      MIRACLE_BIN_DIR: resolve(binDir),
    };
    // Online updates must never reuse an unrelated manual archive from the shell.
    delete installEnv.MIRACLE_ARCHIVE;
    delete installEnv.MIRACLE_CHECKSUM_FILE;
    log(
      `Updating Miracle ${input.currentVersion} → ${target}. Running projects will be stopped; project data stays in place.`,
    );
    await (dependencies.run || runInstaller)(installer, installEnv);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
