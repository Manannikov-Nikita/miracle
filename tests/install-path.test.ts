import { afterEach, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repository = resolve(import.meta.dirname, "..");
const folders: string[] = [];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function fixture(shell = "/bin/zsh", binName = "bin") {
  const local = join(repository, ".local");
  mkdirSync(local, { recursive: true });
  const folder = mkdtempSync(join(local, "miracle PATH fixture "));
  folders.push(folder);
  const home = join(folder, "home"),
    source = join(folder, "payload"),
    install = join(folder, "installed"),
    bin = join(home, binName);
  for (const path of [
    home,
    join(source, "runtime/bin"),
    join(source, "dist/server/server"),
  ])
    mkdirSync(path, { recursive: true });
  copyFileSync(
    join(repository, "release/install.mjs"),
    join(source, "install.mjs"),
  );
  if (existsSync(join(repository, "release/setup-path.mjs")))
    copyFileSync(
      join(repository, "release/setup-path.mjs"),
      join(source, "setup-path.mjs"),
    );
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ type: "module", version: "0.3.1" }),
  );
  writeFileSync(
    join(source, "runtime/bin/node"),
    `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(source, "dist/server/server/cli.js"),
    'console.log("0.3.1");\n',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin",
    SHELL: shell,
    CI: "1",
    MIRACLE_MODIFY_PATH: "yes",
  };
  for (const name of [
    "ZDOTDIR",
    "XDG_CONFIG_HOME",
    "BASH_ENV",
    "ENV",
    "MIRACLE_DATA_DIR",
    "MIRACLE_INSTALL_ROOT",
    "MIRACLE_BIN_DIR",
  ])
    delete env[name];
  function installNow(detached = false) {
    const result = spawnSync(
      process.execPath,
      [join(source, "install.mjs"), source, install, bin],
      {
        cwd: folder,
        env,
        encoding: "utf8",
        timeout: 15_000,
        detached,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return result;
  }
  function shellCommand(shellPath: string, args: string[]) {
    return spawnSync(shellPath, args, {
      cwd: folder,
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
  }
  return { folder, home, source, install, bin, env, installNow, shellCommand };
}

it("makes the installed command available after reading the zsh startup file", () => {
  const f = fixture();
  f.installNow();
  expect(
    existsSync(join(f.home, ".zshrc")),
    "accepted PATH setup must persist a startup entry",
  ).toBe(true);
  const result = f.shellCommand("/bin/sh", [
    "-c",
    '. "$HOME/.zshrc"; miracle --version',
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("0.3.1");
});

it.skipIf(!existsSync("/bin/zsh"))(
  "finds miracle in a fresh interactive zsh terminal",
  () => {
    const f = fixture();
    f.installNow();
    const result = f.shellCommand("/bin/zsh", ["-ic", "miracle --version"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("0.3.1");
  },
);

it("preserves user configuration and does not duplicate PATH after reinstall or sourcing twice", () => {
  const f = fixture();
  const startup = join(f.home, ".zshrc");
  const previous =
    '# Existing settings without final newline\nexport MIRACLE_PATH_FIXTURE="kept"';
  writeFileSync(startup, previous);
  f.installNow();
  const first = readFileSync(startup, "utf8");
  expect(first.startsWith(previous)).toBe(true);
  f.installNow();
  expect(readFileSync(startup, "utf8")).toBe(first);
  const result = f.shellCommand("/bin/sh", [
    "-c",
    '. "$HOME/.zshrc"; . "$HOME/.zshrc"; printf "%s\\n%s\\n" "$MIRACLE_PATH_FIXTURE" "$PATH"',
  ]);
  expect(result.status, result.stderr).toBe(0);
  const [setting, path] = result.stdout.trim().split("\n");
  expect(setting).toBe("kept");
  expect(path.split(":").filter((entry) => entry === f.bin)).toHaveLength(1);
});

it("respects a custom ZDOTDIR instead of editing the home zshrc", () => {
  const f = fixture();
  const config = join(f.home, "zsh settings");
  f.env.ZDOTDIR = config;
  f.installNow();
  expect(existsSync(join(f.home, ".zshrc"))).toBe(false);
  const result = f.shellCommand("/bin/sh", [
    "-c",
    '. "$ZDOTDIR/.zshrc"; miracle --version',
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("0.3.1");
});

it.each([undefined, ".bash_profile", ".bash_login", ".profile"])(
  "makes Bash login and non-login terminals find miracle with %s existing",
  (existing) => {
    const f = fixture("/bin/bash");
    if (existing)
      writeFileSync(join(f.home, existing), "# Existing login configuration\n");
    f.installNow();
    expect(existsSync(join(f.home, existing || ".bash_profile"))).toBe(true);
    if (existing && existing !== ".bash_profile")
      expect(
        existsSync(join(f.home, ".bash_profile")),
        "do not shadow the user's login file",
      ).toBe(false);
    for (const flags of [["-ic"], ["-lc"]]) {
      const result = f.shellCommand("/bin/bash", [
        ...flags,
        "miracle --version",
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("0.3.1");
    }
  },
);

it("quotes spaces, apostrophes, dollars and backticks in the launcher directory without running them", () => {
  const f = fixture("/bin/zsh", "bin ' $(touch injected) `touch backtick`");
  f.installNow();
  const result = f.shellCommand("/bin/sh", [
    "-c",
    '. "$HOME/.zshrc"; miracle --version',
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("0.3.1");
  expect(existsSync(join(f.folder, "injected"))).toBe(false);
  expect(existsSync(join(f.folder, "backtick"))).toBe(false);
});

it.each(["no", "auto"])(
  "leaves startup files alone with %s in CI and still installs the launcher",
  (mode) => {
    const f = fixture();
    f.env.MIRACLE_MODIFY_PATH = mode;
    const result = f.installNow();
    expect(existsSync(join(f.home, ".zshrc"))).toBe(false);
    expect(result.stdout).toContain(f.bin);
    const command = f.shellCommand(join(f.bin, "miracle"), ["--version"]);
    expect(command.status, command.stderr).toBe(0);
    expect(command.stdout.trim()).toBe("0.3.1");
  },
);

it("does not wait for stdin or edit configuration without a controlling terminal", () => {
  const f = fixture();
  delete f.env.CI;
  f.env.MIRACLE_MODIFY_PATH = "auto";
  f.installNow(true);
  expect(existsSync(join(f.home, ".zshrc"))).toBe(false);
  const command = f.shellCommand(join(f.bin, "miracle"), ["--version"]);
  expect(command.status, command.stderr).toBe(0);
  expect(command.stdout.trim()).toBe("0.3.1");
});

it("does not modify startup files when the launcher directory is already in PATH", () => {
  const f = fixture();
  f.env.PATH = f.bin + ":/usr/bin:/bin";
  f.env.MIRACLE_MODIFY_PATH = "auto";
  f.installNow();
  expect(existsSync(join(f.home, ".zshrc"))).toBe(false);
  const result = f.shellCommand("/bin/sh", ["-c", "miracle --version"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("0.3.1");
});

it("persists explicitly requested PATH setup even after a temporary export", () => {
  const f = fixture();
  f.env.PATH = f.bin + ":/usr/bin:/bin";
  f.env.MIRACLE_MODIFY_PATH = "yes";
  f.installNow();
  expect(existsSync(join(f.home, ".zshrc"))).toBe(true);
  f.env.PATH = "/usr/bin:/bin";
  const result = f.shellCommand("/bin/sh", [
    "-c",
    '. "$HOME/.zshrc"; miracle --version',
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("0.3.1");
});

it("writes a usable POSIX profile for sh", () => {
  const f = fixture("/bin/sh");
  f.installNow();
  const result = f.shellCommand("/bin/sh", [
    "-c",
    '. "$HOME/.profile"; miracle --version',
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("0.3.1");
});

it("keeps a successfully installed launcher when shell configuration cannot be written", () => {
  const f = fixture();
  mkdirSync(join(f.home, ".zshrc"));
  const result = f.installNow();
  expect(result.stdout + result.stderr).toContain(f.bin);
  const command = f.shellCommand(join(f.bin, "miracle"), ["--version"]);
  expect(command.status, command.stderr).toBe(0);
  expect(command.stdout.trim()).toBe("0.3.1");
});
