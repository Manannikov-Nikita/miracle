import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
  symlinkSync,
  createWriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
const folders: string[] = [];
afterEach(() =>
  folders
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "miracle install Проверка "));
  folders.push(root);
  const payload = join(root, "payload");
  mkdirSync(join(payload, "runtime/bin"), { recursive: true });
  if (process.platform === "win32")
    cpSync(process.execPath, join(payload, "runtime/node.exe"));
  else symlinkSync(process.execPath, join(payload, "runtime/bin/node"));
  mkdirSync(join(payload, "dist/server/server"), { recursive: true });
  writeFileSync(
    join(payload, "package.json"),
    JSON.stringify({ version: "0.2.0", type: "module" }),
  );
  writeFileSync(
    join(payload, "dist/server/server/cli.js"),
    'console.log("0.2.0")',
  );
  return {
    root,
    payload,
    install: join(root, "installation"),
    bin: join(root, "bin"),
  };
}
it("activates immutable code, preserves data, and runs without system Node from Unicode paths", () => {
  const f = fixture();
  mkdirSync(join(f.install, "data"), { recursive: true });
  writeFileSync(join(f.install, "data", "key"), "retained");
  const install = () =>
    spawnSync(
      process.execPath,
      [resolve("release/install.mjs"), f.payload, f.install, f.bin],
      { encoding: "utf8" },
    );
  let result = install();
  expect(result.status, result.stderr).toBe(0);
  writeFileSync(join(f.install, "versions", "0.2.0", "marker"), "immutable");
  result = install();
  expect(result.status, result.stderr).toBe(0);
  expect(
    readFileSync(join(f.install, "versions", "0.2.0", "marker"), "utf8"),
  ).toBe("immutable");
  expect(readFileSync(join(f.install, "data", "key"), "utf8")).toBe("retained");
  expect(readFileSync(join(f.install, "current-version"), "utf8").trim()).toBe(
    "0.2.0",
  );
  const launch =
    process.platform === "win32"
      ? spawnSync(
          "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `chcp 437 >nul & call "${join(f.bin, "miracle.cmd")}" --version`,
          ],
          { encoding: "utf8", cwd: tmpdir(), windowsVerbatimArguments: true },
        )
      : spawnSync(join(f.bin, "miracle"), ["--version"], {
          encoding: "utf8",
          cwd: tmpdir(),
          env: { ...process.env, PATH: "/usr/bin:/bin" },
        });
  expect(launch.status, launch.stderr).toBe(0);
  expect(launch.stdout.trim()).toBe("0.2.0");
});
it("failed staged validation leaves prior pointer and data intact", () => {
  const f = fixture();
  mkdirSync(f.install);
  writeFileSync(join(f.install, "current-version"), "0.1.0\n");
  writeFileSync(
    join(f.payload, "dist/server/server/cli.js"),
    "process.exit(1)",
  );
  const result = spawnSync(
    process.execPath,
    [resolve("release/install.mjs"), f.payload, f.install, f.bin],
    { encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(f.install, "current-version"), "utf8")).toBe(
    "0.1.0\n",
  );
});

it
  .skipIf(process.platform === "win32")
  .each(["download", "checksum", "extraction"])(
  "shell %s failure preserves the old installation and data",
  (failure) => {
    const f = fixture();
    mkdirSync(f.install);
    writeFileSync(join(f.install, "current-version"), "0.1.0\n");
    mkdirSync(join(f.install, "data"));
    writeFileSync(join(f.install, "data", "encryption.key"), "private key");
    const template = readFileSync(resolve("release/install.sh"), "utf8")
      .replaceAll("__VERSION__", "0.2.0")
      .replaceAll("__REPOSITORY__", "Example/Miracle");
    const script = join(f.root, "install.sh");
    writeFileSync(script, template);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MIRACLE_INSTALL_ROOT: f.install,
      MIRACLE_BIN_DIR: f.bin,
    };
    if (failure === "download") {
      mkdirSync(f.bin);
      writeFileSync(join(f.bin, "curl"), "#!/bin/sh\nexit 22\n", {
        mode: 0o755,
      });
      env.PATH = f.bin + ":/usr/bin:/bin";
    } else {
      const archive = join(f.root, "payload.tar.gz");
      writeFileSync(archive, "broken archive");
      const hash =
        failure === "checksum"
          ? "0".repeat(64)
          : createHash("sha256").update("broken archive").digest("hex");
      writeFileSync(archive + ".sha256", hash + "  payload.tar.gz\n");
      Object.assign(env, { MIRACLE_ARCHIVE: archive });
    }
    const result = spawnSync("sh", [script], { env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.install, "current-version"), "utf8")).toBe(
      "0.1.0\n",
    );
    expect(
      readFileSync(join(f.install, "data", "encryption.key"), "utf8"),
    ).toBe("private key");
  },
);
it.each(["timeout", "unauthorized", "malformed"] as const)(
  "keeps the previous installation when runtime status is %s",
  async (mode) => {
    const { createServer } = await import("node:http");
    const { spawn } = await import("node:child_process");
    const f = fixture();
    mkdirSync(join(f.install, "run"), { recursive: true });
    writeFileSync(join(f.install, "current-version"), "0.1.0\n");
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
      }
      if (mode === "timeout") await new Promise((r) => setTimeout(r, 1700));
      if (mode === "unauthorized") {
        res.writeHead(401).end();
        return;
      }
      res.end(mode === "malformed" ? "invalid" : JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const stateFile = join(f.install, "run", "instance.json");
    const state = JSON.stringify({
      token: "a".repeat(64),
      port,
      pid: process.pid,
      dataDir: join(f.install, "data"),
      version: "0.1.0",
    });
    writeFileSync(stateFile, state);
    try {
      const result = await new Promise<{ code: number | null; out: string }>(
        (res, rej) => {
          const child = spawn(process.execPath, [
            resolve("release/install.mjs"),
            f.payload,
            f.install,
            f.bin,
          ]);
          let out = "";
          child.stdout.on("data", (c) => (out += c));
          child.stderr.on("data", (c) => (out += c));
          child.on("error", rej);
          child.on("close", (code) => res({ code, out }));
        },
      );
      expect(result.code).not.toBe(0);
      expect(readFileSync(join(f.install, "current-version"), "utf8")).toBe(
        "0.1.0\n",
      );
      expect(readFileSync(stateFile, "utf8")).toBe(state);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

it.skipIf(process.platform !== "win32").each(["paths", "links", "checksum"])(
  "Windows ZIP %s rejection preserves the old installation and data",
  async (failure) => {
    const f = fixture();
    mkdirSync(join(f.install, "data"), { recursive: true });
    writeFileSync(join(f.install, "current-version"), "0.1.0\n");
    writeFileSync(join(f.install, "data/encryption.key"), "retained key");
    const archive = join(f.root, "payload.zip");
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      Buffer.from("test entry"),
      "miracle-0.2.0-win-x64/safe/entry",
      {
        mode: failure === "links" ? 0o120777 : 0o100644,
      },
    );
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(archive));
    if (failure === "paths") {
      // Equal-length mutation of both ZIP headers; file data/CRC are unchanged.
      writeFileSync(
        archive,
        Buffer.from(
          readFileSync(archive)
            .toString("latin1")
            .replaceAll("safe/entry", "../x/entry"),
          "latin1",
        ),
      );
    }
    const hash =
      failure === "checksum"
        ? "0".repeat(64)
        : createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(archive + ".sha256", hash + "  payload.zip\n");
    const script = join(f.root, "install.ps1");
    writeFileSync(
      script,
      readFileSync(resolve("release/install.ps1"), "utf8")
        .replaceAll("__VERSION__", "0.2.0")
        .replaceAll("__REPOSITORY__", "Example/Miracle"),
    );
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MIRACLE_INSTALL_ROOT: f.install,
          MIRACLE_BIN_DIR: f.bin,
          MIRACLE_ARCHIVE: archive,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      failure === "paths"
        ? /Unsafe release archive paths/
        : failure === "links"
          ? /unsupported links/
          : /checksum mismatch/,
    );
    expect(readFileSync(join(f.install, "current-version"), "utf8")).toBe(
      "0.1.0\n",
    );
    expect(readFileSync(join(f.install, "data/encryption.key"), "utf8")).toBe(
      "retained key",
    );
  },
);
