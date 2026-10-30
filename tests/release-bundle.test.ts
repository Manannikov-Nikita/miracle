import { it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { create as createTar, extract as extractTar } from "tar";
it("rejects a native Windows release target before producing artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "miracle unsupported release "));
  const output = join(root, "output");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/build-release.mjs",
        "Example/Miracle",
        "0.2.0",
        output,
        "win-x64",
      ],
      { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unsupported release target/);
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each([
  [
    "publishes executable LF bootstrap scripts even from a CRLF checkout",
    false,
    "linux-x64",
  ],
  [
    "preserves Unicode payload and executables when native tar creation fails",
    true,
    "linux-x64",
  ],
])(
  "%s",
  async (_name, nativeCreationFails, target) => {
    // Keep the copied builder beneath the checkout so it resolves build-only dependencies.
    const local = resolve(import.meta.dirname, "../.local");
    mkdirSync(local, { recursive: true });
    const fixture = mkdtempSync(join(local, "miracle release fixture "));
    const extension = "tar.gz";
    const runtimeTop = `node-v24.22.2-${target}`;
    try {
      for (const path of [
        "scripts",
        "release",
        "docs",
        "dist/client",
        "dist/server",
        "dist/client/snow ☃",
        `upstream/${runtimeTop}/bin`,
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
        `upstream/${runtimeTop}/LICENSE`,
        `upstream/${runtimeTop}/bin/node`,
      ])
        writeFileSync(join(fixture, path), "fixture\n");
      writeFileSync(
        join(fixture, "dist/client/snow ☃/данные.txt"),
        "Unicode payload\n",
      );
      writeFileSync(
        join(fixture, "dist/server/executable.sh"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
      const bootstrap =
        "#!/bin/sh\r\nprintf '%s\\n' '__REPOSITORY__ __VERSION__'\r\n";
      writeFileSync(join(fixture, "release/install.sh"), bootstrap);
      const runtime = join(fixture, `runtime.${extension}`);
      await createTar(
        { file: runtime, cwd: join(fixture, "upstream"), gzip: true },
        [runtimeTop],
      );
      writeFileSync(
        join(fixture, "release/node-checksums.json"),
        JSON.stringify({
          version: "24.22.2",
          [String(target)]: createHash("sha256")
            .update(readFileSync(runtime))
            .digest("hex"),
        }),
      );
      const output = join(fixture, "output");
      const fault = join(fixture, "native-tar-fault.mjs");
      writeFileSync(
        fault,
        `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const cp = createRequire(import.meta.url)('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function (file, args, options) {
  if (basename(file) === 'tar') throw new Error('No system archive tool is available to the builder');
  return original(file, args, options);
};
syncBuiltinESMExports();
`,
      );
      const built = spawnSync(
        process.execPath,
        [
          ...(nativeCreationFails
            ? ["--import", pathToFileURL(fault).href]
            : []),
          "scripts/build-release.mjs",
          "Example/Miracle",
          "0.2.0",
          output,
          String(target),
          runtime,
        ],
        { cwd: fixture, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      const extracted = join(fixture, "extracted");
      mkdirSync(extracted);
      const archive = join(output, `miracle-0.2.0-${target}.${extension}`);
      expect(existsSync(archive), "platform-specific release archive").toBe(
        true,
      );
      await extractTar({ file: archive, cwd: extracted, chmod: true });
      const payload = join(extracted, `miracle-0.2.0-${target}`);
      expect(
        readFileSync(join(payload, "dist/client/snow ☃/данные.txt"), "utf8"),
      ).toBe("Unicode payload\n");
      expect(
        readFileSync(join(payload, "dist/server/executable.sh"), "utf8"),
      ).toBe("#!/bin/sh\nexit 0\n");
      expect(
        statSync(join(payload, "dist/server/executable.sh")).mode & 0o777,
      ).toBe(0o755);
      expect(readFileSync(join(output, "install.sh"), "utf8")).toBe(
        "#!/bin/sh\nprintf '%s\\n' 'Example/Miracle 0.2.0'\n",
      );
      const installed = spawnSync("sh", [join(output, "install.sh")], {
        encoding: "utf8",
      });
      expect(installed.status, installed.stderr).toBe(0);
      expect(installed.stdout).toBe("Example/Miracle 0.2.0\n");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
  20_000,
);
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
it("refuses to replace assets of an existing GitHub release", () => {
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
});
