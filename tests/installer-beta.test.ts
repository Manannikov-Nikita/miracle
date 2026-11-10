import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "miracle beta installer "));
  roots.push(root);
  const payload = join(root, "payload");
  const installation = join(root, "installation");
  const bin = join(root, "bin");
  const pointer = join(installation, "current-version");
  mkdirSync(join(payload, "runtime/bin"), { recursive: true });
  mkdirSync(join(payload, "dist/server/server"), { recursive: true });
  symlinkSync(process.execPath, join(payload, "runtime/bin/node"));
  function install(version: string, ...args: string[]) {
    writeFileSync(join(payload, "package.json"), JSON.stringify({ version }));
    writeFileSync(
      join(payload, "dist/server/server/cli.js"),
      `console.log(${JSON.stringify(version)})`,
    );
    return spawnSync(
      process.execPath,
      [resolve("release/install.mjs"), payload, installation, bin, ...args],
      { encoding: "utf8" },
    );
  }
  function launch() {
    return spawnSync(join(bin, "miracle"), ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
  }
  return { root, installation, bin, pointer, install, launch };
}

it.each([
  { version: "0.12.0-beta.1", args: [] },
  { version: "0.12.0-beta.1", args: ["--beta", "--beta"] },
  { version: "0.12.0-beta.1", args: ["--beta", "--unknown"] },
  { version: "0.11.1", args: ["--beta"] },
])(
  "rejects bootstrap invocation $version $args before platform or download work",
  ({ version, args }) => {
    const f = fixture();
    const marker = join(f.root, "attempted-bootstrap-work");
    const bootstrap = readFileSync("release/install.sh", "utf8")
      .replaceAll("__VERSION__", version)
      .replaceAll("__REPOSITORY__", "owner/repository");
    const script = join(f.root, "install.sh");
    const tools = join(f.root, "tools");
    mkdirSync(tools);
    writeFileSync(script, bootstrap);
    for (const tool of ["uname", "curl", "mktemp"])
      writeFileSync(
        join(tools, tool),
        '#!/bin/sh\nprintf attempted > "$MIRACLE_TEST_MARKER"\nexit 1\n',
        { mode: 0o755 },
      );
    const rejected = spawnSync("/bin/sh", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: tools,
        MIRACLE_TEST_MARKER: marker,
        MIRACLE_INSTALL_ROOT: f.installation,
        MIRACLE_BIN_DIR: f.bin,
      },
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/--beta/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(f.installation)).toBe(false);
  },
);

it("requires consent even when the bundled installer is invoked directly", () => {
  const f = fixture();
  const rejected = f.install("0.12.0-beta.1");
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toMatch(/--beta/);
  expect(existsSync(f.installation)).toBe(false);
});

it("installs over an earlier stable release, compares numbered betas and ranks stable highest at the same base", () => {
  const f = fixture();
  const activate = (version: string, ...args: string[]) => {
    const result = f.install(version, ...args);
    expect(result.status, result.stderr).toBe(0);
    const launched = f.launch();
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout.trim()).toBe(version);
  };
  activate("0.11.0");
  activate("0.12.0-beta.1", "--beta");
  activate("0.12.0-beta.10", "--beta");
  for (const [version, args, current] of [
    ["0.12.0-beta.2", ["--beta"], "0.12.0-beta.10"],
    ["0.11.9", [], "0.12.0-beta.10"],
  ] as const) {
    const rejected = f.install(version, ...args);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/downgrade/i);
    expect(readFileSync(f.pointer, "utf8").trim()).toBe(current);
  }
  activate("0.12.0-beta.9007199254740991", "--beta");
  activate("0.12.0");
  const rejected = f.install("0.12.0-beta.99", "--beta");
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toMatch(/downgrade/i);
  expect(readFileSync(f.pointer, "utf8").trim()).toBe("0.12.0");
});

it.each([
  "0.12.0-beta.0",
  "0.12.0-beta.01",
  "0.12.0-beta.9007199254740992",
  "9007199254740992.12.0-beta.1",
  "0.12.0-rc.1",
  "0.12.0-beta.1\n",
  "0.12.0-beta.1/../escape",
])("rejects malformed or unsafe beta payload version %s", (version) => {
  const f = fixture();
  const rejected = f.install(version, "--beta");
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toMatch(/invalid installation version/i);
  expect(existsSync(f.installation)).toBe(false);
});

it("rejects malformed or unsafe active pointers before launcher execution", () => {
  const f = fixture();
  const installed = f.install("0.11.0");
  expect(installed.status, installed.stderr).toBe(0);
  for (const version of [
    "0.12.0-beta.01",
    "0.12.0-beta.9007199254740992",
    "9007199254740992.0.0",
    "..",
    "0.11.0\n0.12.0-beta.1",
    "0.11.0\0invalid",
  ]) {
    writeFileSync(f.pointer, version + "\n");
    const rejected = f.launch();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/invalid miracle version pointer/i);
  }
});
