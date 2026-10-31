import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseUpdateArguments, updateInstallation } from "../src/server/update";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(current = "0.3.0") {
  const root = await mkdtemp(join(tmpdir(), "miracle update Проверка "));
  roots.push(root);
  const packageRoot = join(root, "versions", current);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(root, "current-version"), current + "\n");
  const binDir = join(root, "custom bin");
  await writeFile(
    join(root, "installation.json"),
    JSON.stringify({ version: 1, binDir }),
  );
  const run = vi.fn(async () => {});
  const log = vi.fn();
  const fetchRelease = vi.fn(async (input: string) => {
    if (input.includes("api.github.com"))
      return new Response(
        JSON.stringify({ tag_name: "v0.4.0", draft: false, prerelease: false }),
      );
    return new Response(
      "#!/bin/sh\nVERSION='0.4.0'\nREPOSITORY='Manannikov-Nikita/miracle'\n",
    );
  });
  return { root, packageRoot, current, binDir, run, log, fetchRelease };
}
async function installerFixture() {
  const f = await fixture();
  const payload = join(f.root, "payload");
  await mkdir(join(payload, "runtime/bin"), { recursive: true });
  await mkdir(join(payload, "dist/server/server"), { recursive: true });
  await writeFile(
    join(payload, "package.json"),
    JSON.stringify({ version: "0.4.0", type: "module" }),
  );
  await symlink(process.execPath, join(payload, "runtime/bin/node"));
  await writeFile(
    join(payload, "dist/server/server/cli.js"),
    "console.log('0.4.0');\n",
  );
  // A contacted instance records the request then behaves like a stopped service.
  const probe = join(f.root, "control-contacted");
  const preload = join(f.root, "probe.mjs");
  await writeFile(
    preload,
    `import { writeFileSync } from 'node:fs';\nglobalThis.fetch = async () => { writeFileSync(${JSON.stringify(probe)}, 'contacted'); throw new Error('refused', {cause:{code:'ECONNREFUSED'}}); };\n`,
  );
  await mkdir(join(f.root, "run"));
  const registry = JSON.stringify({
    port: 3001,
    token: "a".repeat(64),
    dataDir: join(f.root, "data"),
    version: "0.5.0",
  });
  await writeFile(join(f.root, "run", "existing.json"), registry);
  const install = async () => {
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        preload,
        resolve("release/install.mjs"),
        payload,
        f.root,
        f.binDir,
      ],
      { timeout: 15000 },
    );
  };
  return { ...f, payload, probe, registry, install };
}
describe("release updater", () => {
  it("checks without writing, launching the installer or accessing project storage", async () => {
    const f = await fixture();
    const before = await readdir(f.root);
    await updateInstallation(
      {
        installRoot: f.root,
        packageRoot: f.packageRoot,
        currentVersion: f.current,
        args: ["--check"],
      },
      { fetch: f.fetchRelease, run: f.run, log: f.log },
    );
    expect(f.run).not.toHaveBeenCalled();
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    expect(await readdir(f.root)).toEqual(before);
    expect(f.log.mock.calls.flat().join("\n")).toMatch(/0\.4\.0.*available/);
  });
  it("uses a pinned official installer and preserves the custom install and bin directories", async () => {
    const f = await fixture();
    await updateInstallation(
      {
        installRoot: f.root,
        packageRoot: f.packageRoot,
        currentVersion: f.current,
        args: [],
        env: {
          MIRACLE_ARCHIVE: "/old.tar.gz",
          MIRACLE_CHECKSUM_FILE: "/old.sha256",
        },
      },
      { fetch: f.fetchRelease, run: f.run, log: f.log },
    );
    expect(f.fetchRelease.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/Manannikov-Nikita/miracle/releases/latest",
      "https://github.com/Manannikov-Nikita/miracle/releases/download/v0.4.0/install.sh",
    ]);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0]?.[1]).toMatchObject({
      MIRACLE_INSTALL_ROOT: f.root,
      MIRACLE_BIN_DIR: f.binDir,
    });
    expect(f.run.mock.calls[0]?.[1]).not.toHaveProperty("MIRACLE_ARCHIVE");
    expect(f.run.mock.calls[0]?.[1]).not.toHaveProperty(
      "MIRACLE_CHECKSUM_FILE",
    );
  });
  it.each(["../0.4.0", "v0.4.0", "0.4", "0.4.0;sh", "01.2.3"])(
    "rejects invalid target %s before network access",
    (version) => {
      expect(() => parseUpdateArguments(["--to", version])).toThrow(/version/i);
    },
  );
  it("refuses source checkouts and stale installed executables before network access", async () => {
    const f = await fixture();
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.root,
          currentVersion: f.current,
          args: [],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/installed/i);
    expect(f.fetchRelease).not.toHaveBeenCalled();
  });
  it("refuses downgrades before downloading an installer", async () => {
    const f = await fixture("0.5.0");
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: [],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/downgrade/i);
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("does not reinstall the current version", async () => {
    const f = await fixture("0.4.0");
    await updateInstallation(
      {
        installRoot: f.root,
        packageRoot: f.packageRoot,
        currentVersion: f.current,
        args: [],
      },
      { fetch: f.fetchRelease, run: f.run, log: f.log },
    );
    expect(f.run).not.toHaveBeenCalled();
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
  });
  it("refuses a mismatched downloaded installer", async () => {
    const f = await fixture();
    f.fetchRelease.mockImplementation(async (url) =>
      url.includes("api.github.com")
        ? new Response(
            JSON.stringify({
              tag_name: "v0.4.0",
              draft: false,
              prerelease: false,
            }),
          )
        : new Response("VERSION='0.2.0'\nREPOSITORY='elsewhere/repo'"),
    );
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: [],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/installer/i);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("propagates a failed installer and leaves activation to it", async () => {
    const f = await fixture();
    f.run.mockRejectedValue(new Error("Installer exited with status 1"));
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: ["--to", "0.4.0"],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/status 1/);
    expect(f.fetchRelease.mock.calls[0]?.[0]).toContain("/tags/v0.4.0");
  });
  it("rejects a stale update when a newer version activates during the download", async () => {
    const f = await installerFixture();
    const originalFetch = f.fetchRelease.getMockImplementation()!;
    f.fetchRelease.mockImplementation(async (url) => {
      if (url.includes("api.github.com"))
        await writeFile(join(f.root, "current-version"), "0.5.0\n");
      return originalFetch(url);
    });
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: [],
        },
        { fetch: f.fetchRelease, run: f.install, log: f.log },
      ),
    ).rejects.toThrow(/downgrade/i);
    expect(await readFile(join(f.root, "current-version"), "utf8")).toBe(
      "0.5.0\n",
    );
    expect(await readFile(join(f.root, "run", "existing.json"), "utf8")).toBe(
      f.registry,
    );
    expect(await readdir(f.root)).not.toContain("control-contacted");
    expect(await readdir(join(f.root, "versions"))).toEqual(["0.3.0"]);
    expect(await readdir(f.root)).not.toContain(".install-lock");
  });
  it("rejects a manual older installer under the activation lock before stopping projects", async () => {
    const f = await installerFixture();
    await writeFile(join(f.root, "current-version"), "0.5.0\n");
    await expect(f.install()).rejects.toThrow(/downgrade/i);
    expect(await readFile(join(f.root, "current-version"), "utf8")).toBe(
      "0.5.0\n",
    );
    expect(await readFile(join(f.root, "run", "existing.json"), "utf8")).toBe(
      f.registry,
    );
    expect(await readdir(f.root)).not.toContain("control-contacted");
    expect(await readdir(join(f.root, "versions"))).toEqual(["0.3.0"]);
  });
});
