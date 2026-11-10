import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const nativeTarget = `${process.platform}-${process.arch}`;
const versionManifest = async (root) =>
  JSON.parse(await readFile(join(root, "release/duckdb-assets.json"), "utf8"));

async function verifiedBytes(file, expected) {
  const data = await readFile(file);
  if (createHash("sha256").update(data).digest("hex") !== expected)
    throw new Error(`Pinned DuckDB Excel checksum mismatch for ${file}`);
  return data;
}

export async function stageDuckDBAssets(root, target, destination) {
  const manifest = await versionManifest(root);
  const info = manifest.targets[target];
  if (!info) throw new Error(`Unsupported DuckDB release target: ${target}`);
  const packageManifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (
    packageManifest.dependencies["@duckdb/node-api"] !== manifest.nodeApiVersion
  )
    throw new Error(
      "The DuckDB Excel asset must match the pinned Node API version.",
    );
  const cache = join(
    root,
    ".local/duckdb",
    manifest.engineVersion,
    info.platform,
    "excel.duckdb_extension.gz",
  );
  let compressed;
  try {
    compressed = await verifiedBytes(cache, info.excelSha256);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = `${cache}.${randomUUID()}`;
    await mkdir(dirname(cache), { recursive: true });
    try {
      execFileSync(
        "curl",
        [
          "-fL",
          "--retry",
          "3",
          "--silent",
          "--show-error",
          `https://extensions.duckdb.org/${manifest.engineVersion}/${info.platform}/excel.duckdb_extension.gz`,
          "-o",
          temporary,
        ],
        { stdio: "inherit" },
      );
      compressed = await verifiedBytes(temporary, info.excelSha256);
      await rename(temporary, cache);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await mkdir(destination, { recursive: true });
  const extension = join(destination, "excel.duckdb_extension");
  const temporary = `${extension}.${randomUUID()}`;
  try {
    await writeFile(temporary, gunzipSync(compressed));
    await rename(temporary, extension);
  } finally {
    await rm(temporary, { force: true });
  }
  return extension;
}

export async function verifyBundledDuckDB(root, stage, target, extension) {
  const manifest = await versionManifest(root);
  const binding = JSON.parse(
    await readFile(
      join(
        stage,
        "node_modules/@duckdb",
        `node-bindings-${target}`,
        "package.json",
      ),
      "utf8",
    ),
  );
  if (binding.version !== manifest.nodeApiVersion)
    throw new Error(
      "The bundled DuckDB native binding does not match the pinned version.",
    );
  if (target !== nativeTarget) return;
  execFileSync(
    join(stage, "runtime/bin/node"),
    [
      "--input-type=module",
      "-e",
      `
    import duckdb, { DuckDBInstance } from "@duckdb/node-api";
    const { version, platform, extension } = JSON.parse(process.argv[1]);
    if (duckdb.version() !== version) throw Error("Unexpected native DuckDB version.");
    const database = await DuckDBInstance.create(":memory:", {
      autoinstall_known_extensions: "false", autoload_known_extensions: "false",
      allow_unsigned_extensions: "false",
    });
    const connection = await database.connect();
    const result = await connection.runAndReadAll("PRAGMA platform");
    if (result.getRows()[0][0] !== platform) throw Error("Unexpected native DuckDB platform.");
    await connection.run("LOAD '" + extension.replaceAll("'", "''") + "'");
    connection.closeSync();
    database.closeSync();
  `,
      JSON.stringify({
        version: manifest.engineVersion,
        platform: manifest.targets[target].platform,
        extension,
      }),
    ],
    { cwd: stage, stdio: "inherit" },
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const root = resolve(import.meta.dirname, "..");
  await stageDuckDBAssets(
    root,
    nativeTarget,
    join(root, "dist/server/native/duckdb"),
  );
}
