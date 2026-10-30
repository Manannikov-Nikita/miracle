import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
  mkdtemp,
  chmod,
} from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { create as createTar } from "tar";

const root = resolve(import.meta.dirname, "..");
// Git Bash puts GNU tar on PATH; Windows releases need the system bsdtar
// for ZIP extraction and native drive-letter paths.
const tar =
  process.platform === "win32"
    ? join(
        process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
        "System32",
        "tar.exe",
      )
    : "tar";
const [repository, version, outputArgument, targetArgument, runtimeArgument] =
  process.argv.slice(2);
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository || "") ||
  !/^\d+\.\d+\.\d+$/.test(version || "")
)
  throw new Error(
    "Usage: node scripts/build-release.mjs owner/repository 1.2.3 [output-directory] [darwin-arm64|darwin-x64|linux-arm64|linux-x64|win-x64] [verified-node-archive]",
  );
const target =
  targetArgument ||
  `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const checksums = JSON.parse(
  await readFile(join(root, "release/node-checksums.json"), "utf8"),
);
if (!checksums[target])
  throw new Error(`Unsupported release target: ${target}`);
if (
  JSON.parse(await readFile(join(root, "package.json"), "utf8")).version !==
  version
)
  throw new Error("Release version must match package.json.");
const output = resolve(outputArgument || join(root, ".local/releases"));
const name = `miracle-${version}-${target}`;
const work = await mkdtemp(join(tmpdir(), "miracle-release-"));
const stage = join(work, name);
await mkdir(stage);
await mkdir(output, { recursive: true });
const upstream = `node-v${checksums.version}-${target}.${target.startsWith("win-") ? "zip" : "tar.gz"}`;
try {
  const runtimeArchive = runtimeArgument
    ? resolve(runtimeArgument)
    : join(work, upstream);
  if (!runtimeArgument)
    execFileSync(
      "curl",
      [
        "-fL",
        "--retry",
        "3",
        `https://nodejs.org/dist/v${checksums.version}/${upstream}`,
        "-o",
        runtimeArchive,
      ],
      { stdio: "inherit" },
    );
  const sha = createHash("sha256")
    .update(await readFile(runtimeArchive))
    .digest("hex");
  if (sha !== checksums[target])
    throw new Error("Pinned upstream Node checksum mismatch.");
  const unpacked = join(work, "upstream");
  await mkdir(unpacked);
  execFileSync(tar, ["-xf", runtimeArchive, "-C", unpacked], {
    stdio: "inherit",
  });
  const runtime = join(unpacked, `node-v${checksums.version}-${target}`);
  await mkdir(
    join(stage, "runtime", ...(target.startsWith("win-") ? [] : ["bin"])),
    { recursive: true },
  );
  await cp(
    join(runtime, target.startsWith("win-") ? "node.exe" : "bin/node"),
    join(stage, "runtime", target.startsWith("win-") ? "node.exe" : "bin/node"),
  );
  if (!target.startsWith("win-"))
    await chmod(join(stage, "runtime/bin/node"), 0o755);
  await cp(join(runtime, "LICENSE"), join(stage, "runtime/LICENSE"));
  // Explicit allowlist: never copy working-tree roots, environments, keys, or user data.
  for (const file of [
    "package.json",
    "package-lock.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])
    await cp(join(root, file), join(stage, file));
  await mkdir(join(stage, "dist"));
  await cp(join(root, "dist/client"), join(stage, "dist/client"), {
    recursive: true,
  });
  await cp(join(root, "dist/server"), join(stage, "dist/server"), {
    recursive: true,
  });
  await cp(join(root, "docs/local-installation.md"), join(stage, "README.md"));
  await cp(join(root, "release/install.mjs"), join(stage, "install.mjs"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(
    npm,
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--bin-links=false",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: stage, stdio: "inherit", shell: process.platform === "win32" },
  );
  const archive = join(output, `${name}.tar.gz`);
  await rm(archive, { force: true });
  // Some Windows bsdtar builds crash while traversing non-ANSI filenames
  // shipped by dependencies. Keep archive creation portable across all hosts.
  await createTar(
    { file: archive, cwd: work, gzip: true, portable: true, strict: true },
    [name],
  );
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  for (const file of ["install.sh", "install.ps1"])
    await writeFile(
      join(output, file),
      (await readFile(join(root, "release", file), "utf8"))
        .replace(/\r\n?/g, "\n")
        .replaceAll("__VERSION__", version)
        .replaceAll("__REPOSITORY__", repository),
    );
  console.log(archive);
} finally {
  await rm(work, { recursive: true, force: true });
}
