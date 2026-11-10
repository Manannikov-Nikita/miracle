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
const releasesUrl = `https://api.github.com/repos/${repository}/releases`;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
type ReleaseVersion = { version: string; parts: number[]; beta: boolean };
function parseVersion(version: string): ReleaseVersion {
  const match = versionPattern.exec(version);
  if (!match || match[0] !== version)
    throw new Error("Invalid release version: expected X.Y.Z or X.Y.Z-beta.N.");
  const parts = match
    .slice(1)
    .filter((part) => part !== undefined)
    .map(Number);
  if (!parts.every(Number.isSafeInteger))
    throw new Error("Invalid release version.");
  const beta = parts.length === 4;
  if (!beta) parts.push(Infinity);
  return { version, parts, beta };
}
function compareVersions(left: ReleaseVersion, right: ReleaseVersion) {
  for (let i = 0; i < 4; i++) {
    if (left.parts[i] !== right.parts[i])
      return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  return 0;
}
export function parseUpdateArguments(args: string[]) {
  let check = false,
    beta = false,
    to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--check" && !check) check = true;
    else if (value === "--beta" && !beta) beta = true;
    else if (value === "--to" && to === undefined) {
      to = args[++i];
      if (!to) throw new Error("--to needs a release version.");
    } else
      throw new Error(
        `Unknown update option: ${value}. Use miracle update [--check] [--beta] [--to X.Y.Z[-beta.N]].`,
      );
  }
  if (to && parseVersion(to).beta && !beta)
    throw new Error("Updating to a beta release requires --beta.");
  return { check, beta, to };
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
  run?: (
    installer: string,
    env: NodeJS.ProcessEnv,
    args?: string[],
  ) => Promise<void>;
  log?: (message: string) => void;
}
async function runInstaller(
  installer: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
) {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn("/bin/sh", [installer, ...args], {
      env,
      stdio: "inherit",
    });
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
function publishedVersion(value: unknown, beta: boolean) {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Miracle release metadata.");
  const { tag_name: tag, draft, prerelease } = value as Record<string, unknown>;
  if (
    typeof tag !== "string" ||
    typeof draft !== "boolean" ||
    typeof prerelease !== "boolean"
  )
    throw new Error("Invalid Miracle release metadata.");
  if (draft) return;
  if (prerelease && (!beta || !/^v\d+\.\d+\.\d+(?:$|-beta(?:\.|$))/.test(tag)))
    return;
  if (!tag.startsWith("v")) throw new Error("Invalid Miracle release tag.");
  const version = parseVersion(tag.slice(1));
  if (version.beta !== prerelease)
    throw new Error("Miracle release metadata does not match its version.");
  return version;
}
async function selectRelease(
  request: NonNullable<UpdateDependencies["fetch"]>,
  currentVersion: string,
  { beta, to }: { beta: boolean; to?: string },
) {
  const options: HttpRequestOptions = {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `Miracle/${currentVersion}`,
    },
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  };
  if (!beta || to) {
    const url = `${releasesUrl}/${to ? `tags/v${to}` : "latest"}`;
    const response = await request(url, options);
    const target = publishedVersion(
      JSON.parse(await responseText(response, 1_000_000)),
      beta,
    );
    if (!target)
      throw new Error(
        beta
          ? "Only published stable or numbered beta Miracle releases can be installed."
          : "Only published stable Miracle releases can be installed.",
      );
    if (to && target.version !== to)
      throw new Error("Release metadata does not match the requested version.");
    return target;
  }

  const maxPages = 10;
  let highest: ReleaseVersion | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const response = await request(
      `${releasesUrl}?per_page=100&page=${page}`,
      options,
    );
    const releases: unknown = JSON.parse(
      await responseText(response, 4_000_000),
    );
    if (!Array.isArray(releases) || releases.length > 100)
      throw new Error("Invalid Miracle releases metadata.");
    for (const release of releases) {
      const version = publishedVersion(release, beta);
      if (version && (!highest || compareVersions(version, highest) > 0))
        highest = version;
    }
    // Use GitHub's continuation marker but keep the request on the fixed repository endpoint.
    if (!/;\s*rel="next"/i.test(response.headers.get("link") ?? "")) {
      if (highest) return highest;
      throw new Error(
        "No published stable or numbered beta Miracle releases found.",
      );
    }
  }
  throw new Error(
    "Too many Miracle release pages to determine the newest version safely.",
  );
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
  const { check, beta, to } = parseUpdateArguments(input.args);
  const current = parseVersion(input.currentVersion);
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
  const release = await selectRelease(fetchRelease, input.currentVersion, {
    beta,
    to,
  });
  const target = release.version;
  const comparison = compareVersions(release, current);
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
  if (check) {
    const command = `miracle update${beta ? " --beta" : ""}${to ? ` --to ${to}` : ""}`;
    return log(
      `Miracle ${target} is available (installed: ${input.currentVersion}). Run ${command} to install it.`,
    );
  }
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
    const install = dependencies.run || runInstaller;
    if (release.beta) await install(installer, installEnv, ["--beta"]);
    else await install(installer, installEnv);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
