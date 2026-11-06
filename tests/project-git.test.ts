import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ProjectGit } from "../src/server/project-git";

const binary =
  process.platform === "darwin" &&
  existsSync("/Library/Developer/CommandLineTools/usr/bin/git")
    ? "/Library/Developer/CommandLineTools/usr/bin/git"
    : "git";
let root: string, repo: string, service: ProjectGit;
const git = (...args: string[]) =>
  execFileSync(binary, args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
const file = (path: string, content = path) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const seed = () => {
  file("a.txt", "initial a\n");
  file("b.txt", "initial b\n");
  git("add", ".");
  git("commit", "-m", "initial");
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-git-")));
  repo = join(root, "project");
  mkdirSync(repo);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", ".git/hooks");
  service = new ProjectGit(
    { projectRoot: repo, dataDir: join(repo, "runtime") },
    { gitBinary: binary },
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("represents unborn, non-repository and unavailable Git without inventing a branch", async () => {
  expect(await service.status()).toMatchObject({
    state: "ready",
    branch: "main",
    head: null,
    unborn: true,
    canMutate: true,
  });
  const outside = new ProjectGit(
    { projectRoot: root, dataDir: join(root, "runtime") },
    { gitBinary: binary },
  );
  expect(await outside.status()).toMatchObject({
    state: "not_repository",
    canMutate: false,
  });
  const missing = new ProjectGit(
    { projectRoot: repo, dataDir: join(repo, "runtime") },
    { gitBinary: join(root, "missing-git") },
  );
  expect(await missing.status()).toMatchObject({
    state: "unavailable",
    canMutate: false,
  });
});

it("reports index and disk separately and ignores runtime internals", async () => {
  seed();
  file("a.txt", "staged a\n");
  git("add", "a.txt");
  file("a.txt", "disk a\n");
  file("new file.sql", "select 1");
  file(".miracle/secret", "secret");
  file("runtime/db.sqlite", "secret");
  const status = await service.status();
  expect(status.files).toEqual([
    { path: "a.txt", indexStatus: "M", worktreeStatus: "M", conflicted: false },
    {
      path: "new file.sql",
      indexStatus: "?",
      worktreeStatus: "?",
      conflicted: false,
    },
  ]);
  expect(status.counts).toEqual({
    staged: 1,
    unstaged: 1,
    untracked: 1,
    conflicted: 0,
  });
  expect((await service.diff("a.txt")).patch).toContain("+disk a");
  expect((await service.diff("new file.sql")).patch).toContain("+select 1");
  await expect(service.diff(".miracle/secret")).rejects.toMatchObject({
    statusCode: 400,
  });
  await expect(service.diff("runtime/db.sqlite")).rejects.toMatchObject({
    statusCode: 400,
  });
});

it("commits selected disk contents and keeps unrelated staged and unstaged changes", async () => {
  seed();
  file("a.txt", "staged a\n");
  git("add", "a.txt");
  file("a.txt", "disk a\n");
  file("b.txt", "staged b\n");
  git("add", "b.txt");
  file("b.txt", "disk b\n");
  const status = await service.commit({
    paths: ["a.txt"],
    message: "selected",
    revision: (await service.status()).revision,
  });
  expect(git("show", "HEAD:a.txt")).toBe("disk a\n");
  expect(git("show", "HEAD:b.txt")).toBe("initial b\n");
  expect(git("show", ":b.txt")).toBe("staged b\n");
  expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("disk b\n");
  expect(status.files).toEqual([
    { path: "b.txt", indexStatus: "M", worktreeStatus: "M", conflicted: false },
  ]);
});

it("commits literal special filenames, additions, deletions and whole staged renames", async () => {
  seed();
  renameSync(join(repo, "a.txt"), join(repo, "renamed.txt"));
  git("add", "-A");
  rmSync(join(repo, "b.txt"));
  file("[literal]*.sql", "select 42\n");
  file("unrelated.sql", "keep\n");
  const before = await service.status();
  expect(before.files.find((f) => f.path === "renamed.txt")?.originalPath).toBe(
    "a.txt",
  );
  await service.commit({
    paths: ["renamed.txt", "b.txt", "[literal]*.sql"],
    message: "exact",
    revision: before.revision,
  });
  expect(git("ls-tree", "--name-only", "HEAD").trim().split("\n")).toEqual([
    "[literal]*.sql",
    "renamed.txt",
  ]);
  expect((await service.status()).files.map((f) => f.path)).toEqual([
    "unrelated.sql",
  ]);
});

it("rejects stale content even when the status letters are unchanged", async () => {
  seed();
  file("a.txt", "version one\n");
  const before = await service.status();
  file("a.txt", "version two\n");
  await expect(
    service.commit({
      paths: ["a.txt"],
      message: "stale",
      revision: before.revision,
    }),
  ).rejects.toMatchObject({ statusCode: 409, code: "GIT_STALE" });
  expect(git("log", "-1", "--format=%s").trim()).toBe("initial");
});

it("rejects paths absent from the current exact selection", async () => {
  seed();
  file("a.txt", "changed\n");
  file(".miracle/secret");
  file("runtime/secret");
  for (const path of [
    ".",
    ":(glob)*",
    "../a.txt",
    "/a.txt",
    ".git/config",
    ".miracle/secret",
    "runtime/secret",
    "b.txt",
  ]) {
    await expect(
      service.commit({
        paths: [path],
        message: "bad",
        revision: (await service.status()).revision,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(git("log", "-1", "--format=%s").trim()).toBe("initial");
});

it("leaves the real index byte-identical when commit identity is missing", async () => {
  seed();
  git("config", "user.email", "");
  git("config", "user.name", "");
  file("a.txt", "new a\n");
  file("b.txt", "staged b\n");
  git("add", "b.txt");
  const index = readFileSync(join(repo, ".git/index"));
  await expect(
    service.commit({
      paths: ["a.txt"],
      message: "fail",
      revision: (await service.status()).revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
  expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
  expect(git("log", "-1", "--format=%s").trim()).toBe("initial");
  expect(existsSync(join(repo, ".git/index.lock"))).toBe(false);
});

it("does not bypass executable commit hooks or configured signing", async () => {
  seed();
  file("a.txt", "new a\n");
  const hook = join(repo, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const input = {
    paths: ["a.txt"],
    message: "with hook",
    revision: (await service.status()).revision,
  };
  await expect(service.commit(input)).rejects.toMatchObject({
    code: "GIT_TERMINAL_REQUIRED",
  });
  rmSync(hook);
  git("config", "commit.gpgSign", "true");
  await expect(
    service.commit({ ...input, revision: (await service.status()).revision }),
  ).rejects.toMatchObject({ code: "GIT_TERMINAL_REQUIRED" });
  expect(git("log", "-1", "--format=%s").trim()).toBe("initial");
});

it("creates and switches only local branches from a clean working tree", async () => {
  seed();
  const initial = await service.status();
  expect(
    (
      await service.createBranch({
        name: "feature/sql",
        revision: initial.revision,
      })
    ).branch,
  ).toBe("feature/sql");
  expect(
    (
      await service.switchBranch({
        branch: "main",
        revision: (await service.status()).revision,
      })
    ).branch,
  ).toBe("main");
  file("a.txt", "changed\n");
  await expect(
    service.switchBranch({
      branch: "feature/sql",
      revision: (await service.status()).revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_DIRTY" });
  git("restore", "a.txt");
  file(".miracle/private", "runtime");
  expect(
    (
      await service.switchBranch({
        branch: "feature/sql",
        revision: (await service.status()).revision,
      })
    ).branch,
  ).toBe("feature/sql");
  expect(readFileSync(join(repo, ".miracle/private"), "utf8")).toBe("runtime");
});

it("lists linked worktrees and prevents checking out an occupied branch", async () => {
  seed();
  const other = join(root, "linked");
  git("worktree", "add", "-b", "other", other);
  const status = await service.status();
  expect(status.worktrees).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: other, branch: "other", current: false }),
    ]),
  );
  expect(status.branches).toContainEqual({
    name: "other",
    current: false,
    worktreePath: other,
  });
  const linked = new ProjectGit(
    { projectRoot: other, dataDir: join(other, ".miracle") },
    { gitBinary: binary },
  );
  expect(await linked.status()).toMatchObject({
    isWorktree: true,
    canMutate: true,
    branch: "other",
  });
  await expect(
    service.switchBranch({ branch: "other", revision: status.revision }),
  ).rejects.toMatchObject({ code: "GIT_BRANCH_IN_USE" });
});

it("shows parent repository information but never mutates it from a nested project", async () => {
  seed();
  mkdirSync(join(repo, "nested"));
  const nested = new ProjectGit(
    {
      projectRoot: join(repo, "nested"),
      dataDir: join(repo, "nested", ".miracle"),
    },
    { gitBinary: binary },
  );
  const status = await nested.status();
  expect(status).toMatchObject({
    state: "ready",
    root: repo,
    canMutate: false,
  });
  await expect(
    nested.createBranch({ name: "escape", revision: status.revision }),
  ).rejects.toMatchObject({ code: "GIT_READ_ONLY" });
});

it("represents detached HEAD and previews binary content without leaking symlink targets", async () => {
  seed();
  git("checkout", "--detach");
  const status = await service.status();
  expect(status).toMatchObject({ detached: true, branch: null, unborn: false });
  file("binary.dat", "a\u0000b");
  expect(await service.diff("binary.dat")).toMatchObject({ binary: true });
  const secret = join(root, "secret");
  writeFileSync(secret, "outside secret");
  symlinkSync(secret, join(repo, "link"));
  const patch = (await service.diff("link")).patch;
  expect(patch).not.toContain("outside secret");
  expect(patch).toContain(secret);
});

it("can create the initial selected commit without a preexisting index", async () => {
  file("first.sql", "select 1\n");
  file("other.sql", "select 2\n");
  await service.commit({
    paths: ["first.sql"],
    message: "first",
    revision: (await service.status()).revision,
  });
  expect(git("ls-tree", "--name-only", "HEAD").trim()).toBe("first.sql");
  expect((await service.status()).files.map((f) => f.path)).toEqual([
    "other.sql",
  ]);
});

it("bounds large diff previews without failing the entire Git dialog", async () => {
  seed();
  file("large.sql", "select 1;\n".repeat(1_000_000));
  const diff = await service.diff("large.sql");
  expect(diff.truncated).toBe(true);
  expect(diff.patch.length).toBeLessThanOrEqual(256 * 1024);
});

it("rejects conflict commits without disturbing merge state or index", async () => {
  seed();
  git("checkout", "-b", "conflict");
  file("a.txt", "other\n");
  git("commit", "-am", "other");
  git("checkout", "main");
  file("a.txt", "main\n");
  git("commit", "-am", "main");
  try {
    git("merge", "conflict");
  } catch {
    /* expected conflict */
  }
  const before = await service.status();
  expect(before.counts.conflicted).toBe(1);
  const index = readFileSync(join(repo, ".git/index"));
  await expect(
    service.commit({
      paths: ["a.txt"],
      message: "bad",
      revision: before.revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_CONFLICT" });
  expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
});

it("does not stale Git actions when excluded untracked runtime files change", async () => {
  seed();
  file("a.txt", "changed\n");
  file("runtime/db.sqlite", "one");
  file(".miracle/state", "one");
  const before = await service.status();
  file("runtime/db.sqlite", "new runtime content");
  file(".miracle/state", "two");
  expect((await service.status()).revision).toBe(before.revision);
  await service.commit({
    paths: ["a.txt"],
    message: "file only",
    revision: before.revision,
  });
  expect(git("ls-tree", "--name-only", "HEAD").trim().split("\n")).toEqual([
    "a.txt",
    "b.txt",
  ]);
});

it("refuses branch checkout when a target tracks runtime files even if current status is clean", async () => {
  seed();
  git("checkout", "-b", "unsafe");
  file("runtime/db.sqlite", "old db");
  git("add", "runtime");
  git("commit", "-m", "runtime");
  git("checkout", "main");
  file("runtime/db.sqlite", "live db");
  const status = await service.status();
  expect(status.files).toEqual([]);
  await expect(
    service.switchBranch({ branch: "unsafe", revision: status.revision }),
  ).rejects.toMatchObject({ code: "GIT_INTERNAL_FILES" });
  expect(readFileSync(join(repo, "runtime/db.sqlite"), "utf8")).toBe("live db");
});

it("refuses branch operations when the current tree tracks runtime files", async () => {
  seed();
  file(".miracle/state", "state");
  git("add", ".miracle");
  git("commit", "-m", "state");
  await expect(
    service.createBranch({
      name: "no",
      revision: (await service.status()).revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_INTERNAL_FILES" });
});

it("rejects previous-checkout shorthand instead of using it as a branch name", async () => {
  seed();
  git("checkout", "-b", "other");
  git("checkout", "main");
  await expect(
    service.createBranch({
      name: "@{-1}",
      revision: (await service.status()).revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_INVALID_BRANCH" });
  expect(git("branch", "--show-current").trim()).toBe("main");
});

it("does not execute post-index-change hooks while preparing a selected commit", async () => {
  seed();
  file("a.txt", "changed\n");
  const hook = join(repo, ".git/hooks/post-index-change");
  writeFileSync(hook, "#!/bin/sh\nprintf unsafe > .git/hook-ran\n");
  chmodSync(hook, 0o755);
  await expect(
    service.commit({
      paths: ["a.txt"],
      message: "no hooks",
      revision: (await service.status()).revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_TERMINAL_REQUIRED" });
  expect(existsSync(join(repo, ".git/hook-ran"))).toBe(false);
});

it("does not turn a selected-file commit into the completion of a pending merge", async () => {
  seed();
  git("checkout", "-b", "side");
  file("side.sql", "select 1");
  git("add", ".");
  git("commit", "-m", "side");
  git("checkout", "main");
  git("merge", "--no-commit", "--no-ff", "side");
  const status = await service.status();
  await expect(
    service.commit({
      paths: ["side.sql"],
      message: "selected",
      revision: status.revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_OPERATION_ACTIVE" });
  expect(existsSync(join(repo, ".git/MERGE_HEAD"))).toBe(true);
});

it("preserves a split index and staged additions outside the selected path", async () => {
  seed();
  git("update-index", "--split-index");
  file("a.txt", "selected\n");
  file("other.sql", "staged\n");
  git("add", "other.sql");
  await service.commit({
    paths: ["a.txt"],
    message: "selected",
    revision: (await service.status()).revision,
  });
  expect(git("show", ":other.sql")).toBe("staged\n");
  expect(git("show", "HEAD:a.txt")).toBe("selected\n");
});

it("cannot recursively add a directory that replaced a selected deleted file", async () => {
  seed();
  rmSync(join(repo, "a.txt"));
  file("a.txt/unselected.txt", "other\n");
  file("a.txt/.miracle/secret", "private\n");
  const before = await service.status();
  await expect(
    service.commit({
      paths: ["a.txt"],
      message: "delete only",
      revision: before.revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_INVALID_PATH" });
  expect(
    git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n"),
  ).toEqual(["a.txt", "b.txt"]);
  expect(git("diff", "--cached", "--name-only")).toBe("");
});

it("protects ignored runtime directories when the target tracks an ancestor as a file", async () => {
  seed();
  file(".gitignore", "state/\n");
  git("add", ".gitignore");
  git("commit", "-m", "ignore state");
  git("checkout", "-b", "ancestor");
  file("state", "tracked parent\n");
  git("add", "-f", "state");
  git("commit", "-m", "parent file");
  git("checkout", "main");
  file("state/runtime/db.sqlite", "live database");
  const nested = new ProjectGit(
    { projectRoot: repo, dataDir: join(repo, "state/runtime") },
    { gitBinary: binary },
  );
  await expect(
    nested.switchBranch({
      branch: "ancestor",
      revision: (await nested.status()).revision,
    }),
  ).rejects.toMatchObject({ code: "GIT_INTERNAL_FILES" });
  expect(readFileSync(join(repo, "state/runtime/db.sqlite"), "utf8")).toBe(
    "live database",
  );
});

it("commits a rename without adding a recreated unselected source file", async () => {
  seed();
  git("mv", "a.txt", "renamed.txt");
  file("a.txt", "new unselected source\n");
  await service.commit({
    paths: ["renamed.txt"],
    message: "rename",
    revision: (await service.status()).revision,
  });
  expect(git("ls-tree", "--name-only", "HEAD").trim().split("\n")).toEqual([
    "b.txt",
    "renamed.txt",
  ]);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe(
    "new unselected source\n",
  );
  expect((await service.status()).files.map((f) => f.path)).toEqual(["a.txt"]);
});

it("does not hash private descendants when a rename source becomes a directory", async () => {
  seed();
  git("mv", "a.txt", "renamed.txt");
  file("a.txt/.miracle/secret", "must not enter Git object database\n");
  const secretHash = git("hash-object", "a.txt/.miracle/secret").trim();
  await service.commit({
    paths: ["renamed.txt"],
    message: "rename only",
    revision: (await service.status()).revision,
  });
  expect(() => git("cat-file", "-e", secretHash)).toThrow();
  expect(git("ls-tree", "--name-only", "HEAD").trim().split("\n")).toEqual([
    "b.txt",
    "renamed.txt",
  ]);
});

it("commits deletion of a renamed file subsequently removed from disk", async () => {
  seed();
  git("mv", "a.txt", "renamed.txt");
  rmSync(join(repo, "renamed.txt"));
  await service.commit({
    paths: ["renamed.txt"],
    message: "delete",
    revision: (await service.status()).revision,
  });
  expect(git("ls-tree", "--name-only", "HEAD").trim()).toBe("b.txt");
});

it("does not include a copy source's unrelated staged changes", async () => {
  const original = "original line\n".repeat(50);
  file("a.txt", original);
  git("add", ".");
  git("commit", "-m", "initial");
  git("config", "status.renames", "copies");
  file("r.txt", original);
  file("a.txt", original + "changed\n");
  git("add", ".");
  const status = await service.status();
  expect(status.files.find((f) => f.path === "r.txt")?.indexStatus).toBe("C");
  await service.commit({
    paths: ["r.txt"],
    message: "copy",
    revision: status.revision,
  });
  expect(git("show", "HEAD:a.txt")).toBe(original);
  expect(git("show", "HEAD:r.txt")).toBe(original);
  expect(git("show", ":a.txt")).toBe(original + "changed\n");
});
