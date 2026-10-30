import { it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
it("publishes executable LF bootstrap scripts even from a CRLF checkout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "miracle CRLF release "));
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot!, "System32", "tar.exe")
      : "tar";
  try {
    for (const path of [
      "scripts",
      "release",
      "docs",
      "dist/client",
      "dist/server",
      "upstream/node-v24.22.2-linux-x64/bin",
    ])
      mkdirSync(join(fixture, path), { recursive: true });
    copyFileSync(
      resolve(import.meta.dirname, "../scripts/build-release.mjs"),
      join(fixture, "scripts/build-release.mjs"),
    );
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ name: "release-fixture", version: "0.2.0" }),
    );
    writeFileSync(
      join(fixture, "package-lock.json"),
      JSON.stringify({
        name: "release-fixture",
        version: "0.2.0",
        lockfileVersion: 3,
        packages: { "": { name: "release-fixture", version: "0.2.0" } },
      }),
    );
    for (const path of [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "docs/local-installation.md",
      "dist/client/index.html",
      "dist/server/index.js",
      "release/install.mjs",
      "upstream/node-v24.22.2-linux-x64/LICENSE",
      "upstream/node-v24.22.2-linux-x64/bin/node",
    ])
      writeFileSync(join(fixture, path), "fixture\n");
    const bootstrap =
      "#!/bin/sh\r\nprintf '%s\\n' '__REPOSITORY__ __VERSION__'\r\n";
    writeFileSync(join(fixture, "release/install.sh"), bootstrap);
    writeFileSync(
      join(fixture, "release/install.ps1"),
      "$Version = '__VERSION__'\r\n$Repository = '__REPOSITORY__'\r\n",
    );
    const runtime = join(fixture, "runtime.tar.gz");
    const packed = spawnSync(
      tar,
      [
        "-czf",
        runtime,
        "-C",
        join(fixture, "upstream"),
        "node-v24.22.2-linux-x64",
      ],
      { encoding: "utf8" },
    );
    expect(packed.status, packed.stderr).toBe(0);
    writeFileSync(
      join(fixture, "release/node-checksums.json"),
      JSON.stringify({
        version: "24.22.2",
        "linux-x64": createHash("sha256")
          .update(readFileSync(runtime))
          .digest("hex"),
      }),
    );
    const output = join(fixture, "output");
    const built = spawnSync(
      process.execPath,
      [
        "scripts/build-release.mjs",
        "Example/Miracle",
        "0.2.0",
        output,
        "linux-x64",
        runtime,
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    expect(built.status, built.stderr).toBe(0);
    expect(readFileSync(join(output, "install.sh"), "utf8")).toBe(
      "#!/bin/sh\nprintf '%s\\n' 'Example/Miracle 0.2.0'\n",
    );
    expect(readFileSync(join(output, "install.ps1"), "utf8")).toBe(
      "$Version = '0.2.0'\n$Repository = 'Example/Miracle'\n",
    );
    if (process.platform !== "win32") {
      const installed = spawnSync("sh", [join(output, "install.sh")], {
        encoding: "utf8",
      });
      expect(installed.status, installed.stderr).toBe(0);
      expect(installed.stdout).toBe("Example/Miracle 0.2.0\n");
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 20_000);
it("refuses an unverified runtime before producing or replacing a release archive", () => {
  const output = mkdtempSync(join(tmpdir(), "miracle runtime integrity "));
  try {
    const runtime = join(output, "node.tar.gz");
    writeFileSync(runtime, "not the pinned Node runtime");
    const archive = join(output, "miracle-0.2.0-darwin-arm64.tar.gz");
    writeFileSync(archive, "prior verified artifact");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/build-release.mjs",
        "Example/Miracle",
        "0.2.0",
        output,
        "darwin-arm64",
        runtime,
      ],
      { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum mismatch/i);
    expect(readFileSync(archive, "utf8")).toBe("prior verified artifact");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
it.skipIf(process.platform === "win32")(
  "refuses to replace assets of an existing GitHub release",
  () => {
    const folder = mkdtempSync(join(tmpdir(), "miracle immutable release "));
    try {
      const tools = join(folder, "tools");
      mkdirSync(tools);
      const mutation = join(folder, "mutation");
      writeFileSync(
        join(tools, "gh"),
        '#!/bin/sh\nif [ "$1 $2" = "release view" ]; then exit 0; fi\nprintf changed > "$RELEASE_MUTATION"\n',
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        ["scripts/publish-release.mjs", "v0.2.0", folder],
        {
          cwd: resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: tools + ":" + process.env.PATH,
            RELEASE_MUTATION: mutation,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/already exists|immutable/i);
      expect(existsSync(mutation)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
