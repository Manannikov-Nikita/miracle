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
  const run = vi.fn(
    async (_installer: string, _env: NodeJS.ProcessEnv, _args?: string[]) => {},
  );
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
    expect(f.run.mock.calls[0]).toHaveLength(2);
    expect(f.run.mock.calls[0]?.[1]).toMatchObject({
      MIRACLE_INSTALL_ROOT: f.root,
      MIRACLE_BIN_DIR: f.binDir,
    });
    expect(f.run.mock.calls[0]?.[1]).not.toHaveProperty("MIRACLE_ARCHIVE");
    expect(f.run.mock.calls[0]?.[1]).not.toHaveProperty(
      "MIRACLE_CHECKSUM_FILE",
    );
  });
  it.each([
    "../0.4.0",
    "v0.4.0",
    "0.4",
    "0.4.0;sh",
    "01.2.3",
    "0.4.0\n",
    "9007199254740992.0.0",
    "0.4.0-beta.0",
    "0.4.0-beta.01",
    "0.4.0-beta.9007199254740992",
    "0.4.0-rc.1",
  ])("rejects invalid target %s before network access", (version) => {
    expect(() => parseUpdateArguments(["--to", version, "--beta"])).toThrow(
      /version/i,
    );
  });
  it("requires explicit beta consent before requesting targeted release metadata", async () => {
    const f = await fixture();
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: ["--to", "0.4.0-beta.1"],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/requires --beta/i);
    expect(f.fetchRelease).not.toHaveBeenCalled();
    expect(
      parseUpdateArguments(["--to", "0.4.0-beta.1", "--beta", "--check"]),
    ).toEqual({
      to: "0.4.0-beta.1",
      beta: true,
      check: true,
    });
  });
  it("refuses prerelease metadata from the default stable endpoint", async () => {
    const f = await fixture();
    f.fetchRelease.mockResolvedValue(
      Response.json({
        tag_name: "v0.4.0-beta.1",
        draft: false,
        prerelease: true,
      }),
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
    ).rejects.toThrow(/stable/i);
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("selects the highest permitted release across pages and passes consent to the beta installer", async () => {
    const f = await fixture();
    const releasesUrl =
      "https://api.github.com/repos/Manannikov-Nikita/miracle/releases";
    f.fetchRelease.mockImplementation(async (url) => {
      if (url === `${releasesUrl}?per_page=100&page=1`)
        return Response.json(
          [
            { tag_name: "v0.4.0-beta.2", draft: false, prerelease: true },
            { tag_name: "v0.3.9", draft: false, prerelease: false },
            { tag_name: "v9.0.0-beta.1", draft: true, prerelease: true },
            { tag_name: "v8.0.0-rc.1", draft: false, prerelease: true },
          ],
          {
            headers: {
              link: `<${releasesUrl}?per_page=100&page=2>; rel="next"`,
            },
          },
        );
      if (url === `${releasesUrl}?per_page=100&page=2`)
        return Response.json([
          { tag_name: "v0.4.0-beta.10", draft: false, prerelease: true },
        ]);
      return new Response(
        "#!/bin/sh\nVERSION='0.4.0-beta.10'\nREPOSITORY='Manannikov-Nikita/miracle'\n",
      );
    });
    await updateInstallation(
      {
        installRoot: f.root,
        packageRoot: f.packageRoot,
        currentVersion: f.current,
        args: ["--beta"],
      },
      { fetch: f.fetchRelease, run: f.run, log: f.log },
    );
    expect(f.fetchRelease.mock.calls.map(([url]) => url)).toEqual([
      `${releasesUrl}?per_page=100&page=1`,
      `${releasesUrl}?per_page=100&page=2`,
      "https://github.com/Manannikov-Nikita/miracle/releases/download/v0.4.0-beta.10/install.sh",
    ]);
    expect(f.run.mock.calls[0]?.[2]).toEqual(["--beta"]);
  });
  it("permits a targeted numbered beta only with matching published metadata", async () => {
    const f = await fixture();
    f.fetchRelease.mockResolvedValue(
      Response.json({
        tag_name: "v0.4.0-beta.2",
        draft: false,
        prerelease: true,
      }),
    );
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: ["--beta", "--to", "0.4.0-beta.1"],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/metadata does not match/i);
    expect(f.fetchRelease.mock.calls[0]?.[0]).toContain("/tags/v0.4.0-beta.1");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("checks a targeted beta without downloading it and includes consent in the suggested command", async () => {
    const f = await fixture();
    f.fetchRelease.mockResolvedValue(
      Response.json({
        tag_name: "v0.4.0-beta.1",
        draft: false,
        prerelease: true,
      }),
    );
    await updateInstallation(
      {
        installRoot: f.root,
        packageRoot: f.packageRoot,
        currentVersion: f.current,
        args: ["--check", "--beta", "--to", "0.4.0-beta.1"],
      },
      { fetch: f.fetchRelease, run: f.run, log: f.log },
    );
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.log.mock.calls[0]?.[0]).toContain(
      "miracle update --beta --to 0.4.0-beta.1",
    );
  });
  it("bounds release pagination without downloading an installer from an incomplete listing", async () => {
    const f = await fixture();
    f.fetchRelease.mockImplementation(async () =>
      Response.json(
        [{ tag_name: "v0.4.0-beta.1", draft: false, prerelease: true }],
        { headers: { link: '<https://untrusted.example/next>; rel="next"' } },
      ),
    );
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: ["--beta"],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/too many.*pages/i);
    expect(f.fetchRelease).toHaveBeenCalledTimes(10);
    expect(
      f.fetchRelease.mock.calls.every(([url]) =>
        url.startsWith(
          "https://api.github.com/repos/Manannikov-Nikita/miracle/releases?",
        ),
      ),
    ).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("rejects malformed release flags before selecting a beta installer", async () => {
    const f = await fixture();
    f.fetchRelease.mockResolvedValue(
      Response.json([
        { tag_name: "v0.4.0-beta.1", draft: false, prerelease: "true" },
      ]),
    );
    await expect(
      updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args: ["--beta"],
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      ),
    ).rejects.toThrow(/metadata/i);
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("refuses an older default stable release from an installed beta", async () => {
    const f = await fixture("0.5.0-beta.1");
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
  it.each([
    { channel: "default stable", args: [] },
    { channel: "beta-enabled", args: ["--beta"] },
  ])(
    "upgrades an installed beta to the stable release of the same version with $channel selection",
    async ({ args }) => {
      const f = await fixture("0.4.0-beta.1");
      const defaultFetch = f.fetchRelease.getMockImplementation()!;
      f.fetchRelease.mockImplementation(async (url) =>
        url.includes("?per_page=")
          ? Response.json([
              { tag_name: "v0.4.0-beta.99", draft: false, prerelease: true },
              { tag_name: "v0.4.0", draft: false, prerelease: false },
            ])
          : defaultFetch(url),
      );
      await updateInstallation(
        {
          installRoot: f.root,
          packageRoot: f.packageRoot,
          currentVersion: f.current,
          args,
        },
        { fetch: f.fetchRelease, run: f.run, log: f.log },
      );
      expect(f.fetchRelease.mock.calls.at(-1)?.[0]).toContain(
        "/download/v0.4.0/install.sh",
      );
      expect(f.run.mock.calls[0]).toHaveLength(2);
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
        : new Response("VERSION='0.3.0'\nREPOSITORY='elsewhere/repo'"),
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
