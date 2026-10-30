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
import { create as createTar, extract as extractTar } from "tar";

const root = resolve(import.meta.dirname, "..");
if (!["darwin", "linux"].includes(process.platform))
  throw new Error("Build Miracle on macOS or Linux. On Windows, use WSL2.");
const [repository, version, outputArgument, targetArgument, runtimeArgument] =
  process.argv.slice(2);
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository || "") ||
  !/^\d+\.\d+\.\d+$/.test(version || "")
)
  throw new Error(
    "Usage: node scripts/build-release.mjs owner/repository 1.2.3 [output-directory] [darwin-arm64|darwin-x64|linux-arm64|linux-x64] [verified-node-archive]",
  );
const target = targetArgument || `${process.platform}-${process.arch}`;
const checksums = JSON.parse(
  await readFile(join(root, "release/node-checksums.json"), "utf8"),
);
if (
  !["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(
    target,
  ) ||
  !checksums[target]
)
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
const upstream = `node-v${checksums.version}-${target}.tar.gz`;
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
  await extractTar({ file: runtimeArchive, cwd: unpacked, strict: true });
  const runtime = join(unpacked, `node-v${checksums.version}-${target}`);
  await mkdir(join(stage, "runtime/bin"), { recursive: true });
  await cp(join(runtime, "bin/node"), join(stage, "runtime/bin/node"));
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
  execFileSync(
    "npm",
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--bin-links=false",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: stage, stdio: "inherit" },
  );
  const archive = join(output, `${name}.tar.gz`);
  await rm(archive, { force: true });
  await createTar(
    { file: archive, cwd: work, gzip: true, portable: true, strict: true },
    [name],
  );
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  for (const file of ["install.sh"])
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
