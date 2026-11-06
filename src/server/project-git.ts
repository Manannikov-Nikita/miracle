import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { GitDiff, GitFile, GitStatus } from "../shared/project-git.js";
import { problem } from "./project-store.js";

type Context = { projectRoot: string; dataDir: string };
type Revision = { revision: string };
const busy = new Set<string>();
const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const key = (context: Context) => canonical(context.projectRoot);
export function assertProjectGitIdle(context: Context) {
  if (busy.has(key(context)))
    throw problem(409, "Дождитесь завершения операции Git", "GIT_BUSY");
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const PATCH_LIMIT = 256 * 1024;
type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  input?: string;
  allowExit?: number[];
  limit?: number;
  truncate?: boolean;
};

/** Local Git operations only. No command is assembled through a shell. */
export class ProjectGit {
  private binary?: string;
  constructor(
    private context: Context,
    private options: { gitBinary?: string; assertCanMutate?: () => void } = {},
  ) {}

  private execute(
    binary: string,
    args: string[],
    cwd: string,
    options: CommandOptions = {},
  ): Promise<string> {
    // Inherited repository/index overrides must not retarget the configured project.
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (
        /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(
          name,
        )
      )
        delete env[name];
    Object.assign(
      env,
      {
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_PAGER: "cat",
        GIT_EDITOR: "false",
        GIT_SEQUENCE_EDITOR: "false",
        LC_ALL: "C",
      },
      options.env,
    );
    return new Promise((resolveResult, reject) => {
      const child = execFile(
        binary,
        ["--no-pager", ...args],
        {
          cwd,
          env,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: options.limit ?? OUTPUT_LIMIT,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (
            !error ||
            options.allowExit?.includes(Number(error.code)) ||
            (options.truncate &&
              error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          )
            return resolveResult(stdout);
          const detail = stderr.trim().slice(0, 1500);
          const failure = problem(
            400,
            error.killed
              ? "Операция Git превысила лимит времени. Проверьте состояние репозитория"
              : detail || "Не удалось выполнить Git",
            "GIT_COMMAND_FAILED",
          );
          Object.assign(failure, { cause: error, gitStderr: stderr });
          reject(failure);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    });
  }

  private async executable() {
    if (this.binary) return this.binary;
    const configured = this.options.gitBinary || process.env.MIRACLE_GIT_BINARY;
    const candidate = configured || "git";
    try {
      await this.execute(candidate, ["--version"], this.context.projectRoot);
    } catch (error) {
      const detail = String((error as { gitStderr?: string }).gitStderr || "");
      const fallback = "/Library/Developer/CommandLineTools/usr/bin/git";
      if (
        configured ||
        process.platform !== "darwin" ||
        !/license|xcode-select|developer tools/i.test(detail) ||
        !existsSync(fallback)
      )
        throw error;
      await this.execute(fallback, ["--version"], this.context.projectRoot);
      this.binary = fallback;
      return fallback;
    }
    this.binary = candidate;
    return candidate;
  }

  private async run(
    args: string[],
    cwd = this.context.projectRoot,
    options?: CommandOptions,
  ) {
    return this.execute(await this.executable(), args, cwd, options);
  }

  private empty(state: GitStatus["state"], message?: string): GitStatus {
    return {
      state,
      message,
      projectRoot: this.context.projectRoot,
      branch: null,
      head: null,
      detached: false,
      unborn: false,
      isWorktree: false,
      worktrees: [],
      branches: [],
      files: [],
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      revision: "",
      canMutate: false,
    };
  }

  private internalPath(root: string, path: string) {
    if (
      path
        .split("/")
        .some((p) => [".git", ".miracle"].includes(p.toLowerCase()))
    )
      return true;
    const absolute = resolve(root, path);
    return [
      resolve(this.context.dataDir),
      canonical(this.context.dataDir),
    ].some(
      (data) =>
        absolute === data ||
        absolute.startsWith(data + sep) ||
        data.startsWith(absolute + sep),
    );
  }

  private safePath(root: string, path: string) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\0") ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      this.internalPath(root, path)
    )
      return false;
    const absolute = resolve(root, path),
      data = canonical(this.context.dataDir);
    // A file symlink is itself versioned; never follow it. Parent-directory
    // aliases into private state (or outside the worktree) are inaccessible.
    const parent = canonical(dirname(absolute));
    if (parent === data || parent.startsWith(data + sep)) return false;
    return parent === root || parent.startsWith(root + sep);
  }

  private parseFiles(raw: string): GitFile[] {
    const entries = raw.split("\0"),
      files: GitFile[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const indexStatus = entry[0],
        worktreeStatus = entry[1];
      const file: GitFile = {
        path: entry.slice(3),
        indexStatus,
        worktreeStatus,
        conflicted: ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
          entry.slice(0, 2),
        ),
      };
      if (/[RC]/.test(indexStatus + worktreeStatus))
        file.originalPath = entries[++i];
      files.push(file);
    }
    return files;
  }

  private async snapshot(): Promise<{
    status: GitStatus;
    raw: string;
    gitDir?: string;
    indexPath?: string;
  }> {
    try {
      await this.executable();
    } catch {
      return {
        status: this.empty(
          "unavailable",
          "Git недоступен. Установите Git или задайте MIRACLE_GIT_BINARY",
        ),
        raw: "",
      };
    }
    let root: string;
    try {
      root = canonical(
        (await this.run(["rev-parse", "--show-toplevel"])).trim(),
      );
    } catch (error) {
      if (
        /not a git repository|must be run in a work tree/i.test(
          String((error as { gitStderr?: string }).gitStderr),
        )
      )
        return {
          status: this.empty(
            "not_repository",
            "В папке проекта нет репозитория Git",
          ),
          raw: "",
        };
      throw error;
    }
    const [
      raw,
      branchRaw,
      headRaw,
      worktreeRaw,
      branchList,
      gitDirRaw,
      commonRaw,
      indexRaw,
    ] = await Promise.all([
      this.run(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        root,
      ),
      this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], root, {
        allowExit: [1],
      }),
      this.run(["rev-parse", "--verify", "HEAD"], root, { allowExit: [128] }),
      this.run(["worktree", "list", "--porcelain", "-z"], root),
      this.run(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        root,
      ),
      this.run(["rev-parse", "--absolute-git-dir"], root),
      this.run(["rev-parse", "--git-common-dir"], root),
      this.run(["rev-parse", "--git-path", "index"], root),
    ]);
    const branch = branchRaw.trim() || null,
      head = headRaw.trim() || null;
    const gitDir = canonical(gitDirRaw.trim()),
      commonDir = canonical(resolve(root, commonRaw.trim())),
      indexPath = resolve(root, indexRaw.trim());
    const allFiles = this.parseFiles(raw).filter(
      (file) =>
        !(file.indexStatus === "?" && this.internalPath(root, file.path)),
    );
    if (allFiles.length > 10_000)
      throw problem(
        413,
        "Слишком много изменений для окна Git. Используйте терминал",
        "GIT_TOO_LARGE",
      );
    const files = allFiles.filter(
      (f) =>
        this.safePath(root, f.path) &&
        (!f.originalPath || this.safePath(root, f.originalPath)),
    );
    const worktrees: GitStatus["worktrees"] = [];
    let worktree: GitStatus["worktrees"][number] | undefined;
    for (const entry of worktreeRaw.split("\0")) {
      if (entry.startsWith("worktree ")) {
        worktree = {
          path: entry.slice(9),
          head: null,
          branch: null,
          current: canonical(entry.slice(9)) === root,
        };
        worktrees.push(worktree);
      } else if (worktree && entry.startsWith("HEAD "))
        worktree.head = /^0+$/.test(entry.slice(5)) ? null : entry.slice(5);
      else if (worktree && entry.startsWith("branch refs/heads/"))
        worktree.branch = entry.slice(18);
      else if (worktree && entry.startsWith("locked")) worktree.locked = true;
      else if (worktree && entry.startsWith("prunable"))
        worktree.prunable = true;
    }
    const branches = branchList
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((name) => {
        const occupied = worktrees.find((w) => w.branch === name && !w.current);
        return {
          name,
          current: name === branch,
          ...(occupied ? { worktreePath: occupied.path } : {}),
        };
      });
    const digest = createHash("sha256").update(
      JSON.stringify([root, branch, head, allFiles, worktreeRaw, branchList]),
    );
    if (existsSync(indexPath)) {
      if (statSync(indexPath).size > 64 * 1024 * 1024)
        throw problem(
          413,
          "Индекс Git слишком велик. Используйте терминал",
          "GIT_TOO_LARGE",
        );
      digest.update(readFileSync(indexPath));
    }
    // Nanosecond ctime catches same-size rewrites even if callers preserve mtime.
    // Never read/follow the contents of a symlink or a potentially enormous file.
    for (const file of allFiles) {
      try {
        const st = lstatSync(join(root, file.path), { bigint: true });
        digest.update(
          `${file.path}\0${st.mode}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}\0`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const canMutate = canonical(this.context.projectRoot) === root;
    const status: GitStatus = {
      state: "ready",
      projectRoot: this.context.projectRoot,
      root,
      branch,
      head,
      detached: !branch && !!head,
      unborn: !head,
      isWorktree: gitDir !== commonDir,
      worktrees,
      branches,
      files,
      counts: {
        staged: files.filter((f) => ![" ", "?"].includes(f.indexStatus)).length,
        unstaged: files.filter((f) => ![" ", "?"].includes(f.worktreeStatus))
          .length,
        untracked: files.filter((f) => f.indexStatus === "?").length,
        conflicted: files.filter((f) => f.conflicted).length,
      },
      revision: digest.digest("hex"),
      canMutate,
      ...(!canMutate
        ? {
            mutationBlockedReason:
              "Репозиторий находится выше папки проекта. Запустите Miracle из корня рабочего дерева для изменений Git",
          }
        : {}),
    };
    return { status, raw: allFiles.length ? raw : "", gitDir, indexPath };
  }

  async status() {
    return (await this.snapshot()).status;
  }

  async diff(path: string): Promise<GitDiff> {
    const { status } = await this.snapshot();
    if (
      status.state !== "ready" ||
      !status.root ||
      !this.safePath(status.root, path)
    )
      throw problem(400, "Файл недоступен для Git", "GIT_INVALID_PATH");
    const selected = status.files.find((f) => f.path === path);
    if (!selected)
      throw problem(
        400,
        "Файл отсутствует в списке изменений",
        "GIT_INVALID_PATH",
      );
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
    ];
    const preview = { limit: PATCH_LIMIT + 4, truncate: true };
    let patch: string;
    if (selected.indexStatus === "?") {
      // --no-index treats symlinks as link text and never dereferences targets.
      patch = await this.run(
        [...args, "--no-index", "--", "/dev/null", path],
        status.root,
        { ...preview, allowExit: [1] },
      );
    } else if (status.head) {
      patch = await this.run(
        [...args, "HEAD", "--", path],
        status.root,
        preview,
      );
      if (
        selected.originalPath &&
        (selected.indexStatus === "R" || selected.worktreeStatus === "R")
      ) {
        // The rename includes deletion of its former path, even if a new,
        // unselected file has since been created there.
        patch =
          (await this.run(
            [...args, "--cached", "HEAD", "--", selected.originalPath],
            status.root,
            preview,
          )) + patch;
      }
    } else {
      // For an unborn repository use an ephemeral index to represent disk state.
      patch = await this.run(
        [...args, "--no-index", "--", "/dev/null", path],
        status.root,
        { ...preview, allowExit: [1] },
      );
    }
    return {
      path,
      patch: patch.slice(0, PATCH_LIMIT),
      truncated: patch.length > PATCH_LIMIT,
      binary: /(?:Binary files |GIT binary patch)/.test(patch),
      revision: status.revision,
    };
  }

  private async mutation<T>(
    revision: string,
    fn: (snapshot: Awaited<ReturnType<ProjectGit["snapshot"]>>) => Promise<T>,
  ): Promise<T> {
    assertProjectGitIdle(this.context);
    const project = key(this.context);
    busy.add(project);
    try {
      this.options.assertCanMutate?.();
      const snapshot = await this.snapshot();
      if (!snapshot.status.canMutate)
        throw problem(
          409,
          snapshot.status.mutationBlockedReason ||
            snapshot.status.message ||
            "Git недоступен",
          "GIT_READ_ONLY",
        );
      if (snapshot.status.revision !== revision)
        throw problem(
          409,
          "Файлы или состояние Git изменились. Обновите список изменений",
          "GIT_STALE",
        );
      if (snapshot.status.files.some((f) => f.conflicted))
        throw problem(
          409,
          "Сначала разрешите конфликты Git в терминале",
          "GIT_CONFLICT",
        );
      if (
        [
          "MERGE_HEAD",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "rebase-apply",
          "rebase-merge",
          "sequencer",
          "BISECT_LOG",
        ].some((name) => existsSync(join(snapshot.gitDir!, name)))
      )
        throw problem(
          409,
          "В репозитории не завершена merge/rebase/cherry-pick/revert/bisect. Завершите операцию в терминале",
          "GIT_OPERATION_ACTIVE",
        );
      this.options.assertCanMutate?.();
      return await fn(snapshot);
    } finally {
      busy.delete(project);
    }
  }

  private async requireTerminalForHooks(
    root: string,
    action: "commit" | "switch",
  ) {
    const hooks =
      action === "commit"
        ? [
            "pre-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-commit",
            "reference-transaction",
            "post-index-change",
            "pre-auto-gc",
          ]
        : ["post-checkout", "reference-transaction", "post-index-change"];
    const hooksPath = (
      await this.run(["rev-parse", "--git-path", "hooks"], root)
    ).trim();
    for (const name of hooks) {
      try {
        const st = statSync(resolve(root, hooksPath, name));
        if (st.isFile() && (process.platform === "win32" || st.mode & 0o111))
          throw problem(
            409,
            "В репозитории настроены Git hooks. Выполните операцию в терминале: Miracle не отключает hooks и не запускает их в фоне",
            "GIT_TERMINAL_REQUIRED",
          );
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
      }
    }
    if (action === "commit") {
      const signed = (
        await this.run(["config", "--bool", "--get", "commit.gpgSign"], root, {
          allowExit: [1],
        })
      ).trim();
      if (signed === "true")
        throw problem(
          409,
          "Настроена подпись коммитов. Создайте коммит в терминале: Miracle не отключает подпись",
          "GIT_TERMINAL_REQUIRED",
        );
    }
  }

  private async branch(input: Revision & { name: string }, create: boolean) {
    return this.mutation(input.revision, async ({ status, raw }) => {
      const root = status.root!;
      if (raw)
        throw problem(
          409,
          "Для переключения ветки рабочее дерево и индекс должны быть чистыми",
          "GIT_DIRTY",
        );
      if (
        !input.name ||
        ["HEAD", "@"].includes(input.name) ||
        input.name.startsWith("-") ||
        input.name.length > 255 ||
        /[\0\r\n]/.test(input.name)
      )
        throw problem(400, "Недопустимое имя ветки", "GIT_INVALID_BRANCH");
      try {
        await this.run(["check-ref-format", `refs/heads/${input.name}`], root);
      } catch {
        throw problem(400, "Недопустимое имя ветки", "GIT_INVALID_BRANCH");
      }
      const branch = status.branches.find((b) => b.name === input.name);
      if (create && branch)
        throw problem(409, "Ветка уже существует", "GIT_BRANCH_EXISTS");
      if (!create && !branch)
        throw problem(400, "Локальная ветка не найдена", "GIT_INVALID_BRANCH");
      if (branch?.worktreePath)
        throw problem(
          409,
          "Ветка открыта в другом worktree",
          "GIT_BRANCH_IN_USE",
        );
      if (!status.head)
        throw problem(409, "Сначала создайте первый коммит", "GIT_UNBORN");
      const tracked = await Promise.all([
        this.run(["ls-files", "-z"], root),
        this.run(["ls-tree", "-r", "--name-only", "-z", "HEAD"], root),
        ...(create
          ? []
          : [
              this.run(
                [
                  "ls-tree",
                  "-r",
                  "--name-only",
                  "-z",
                  `refs/heads/${input.name}`,
                ],
                root,
              ),
            ]),
      ]);
      if (
        tracked.some((list) =>
          list
            .split("\0")
            .some((path) => path && this.internalPath(root, path)),
        )
      )
        throw problem(
          409,
          "В текущей или выбранной ветке Git отслеживает служебные файлы Miracle. Переключение может затронуть работающую базу; используйте терминал после остановки проекта",
          "GIT_INTERNAL_FILES",
        );
      await this.requireTerminalForHooks(root, "switch");
      if ((await this.snapshot()).status.revision !== input.revision)
        throw problem(
          409,
          "Файлы или состояние Git изменились. Обновите список изменений",
          "GIT_STALE",
        );
      this.options.assertCanMutate?.();
      await this.run(
        create
          ? ["switch", "--no-guess", "--no-overwrite-ignore", "-c", input.name]
          : ["switch", "--no-guess", "--no-overwrite-ignore", input.name],
        root,
      );
      return this.status();
    });
  }
  createBranch(input: Revision & { name: string }) {
    return this.branch(input, true);
  }
  switchBranch(input: Revision & { branch: string }) {
    return this.branch({ ...input, name: input.branch }, false);
  }

  async commit(input: Revision & { paths: string[]; message: string }) {
    return this.mutation(
      input.revision,
      async ({ status, gitDir, indexPath }) => {
        const root = status.root!;
        if (
          !input.message?.trim() ||
          input.message.length > 20_000 ||
          input.message.includes("\0")
        )
          throw problem(
            400,
            "Введите сообщение коммита (до 20 000 символов)",
            "GIT_INVALID_MESSAGE",
          );
        if (!input.paths?.length || input.paths.length > 1000)
          throw problem(
            400,
            "Выберите от 1 до 1000 файлов",
            "GIT_INVALID_PATH",
          );
        const selected: string[] = [],
          addPaths: string[] = [],
          removePaths: string[] = [];
        const requested = new Set(input.paths);
        for (const path of requested) {
          const file = status.files.find((f) => f.path === path);
          if (!this.safePath(root, path) || !file)
            throw problem(
              400,
              "Файл отсутствует в доступном списке изменений",
              "GIT_INVALID_PATH",
            );
          try {
            if (lstatSync(join(root, path)).isDirectory())
              throw problem(
                400,
                "Каталоги и submodule нельзя коммитить через выбор файлов. Используйте терминал",
                "GIT_INVALID_PATH",
              );
            addPaths.push(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            removePaths.push(path);
          }
          selected.push(path);
          if (
            file.originalPath &&
            (file.indexStatus === "R" || file.worktreeStatus === "R")
          ) {
            selected.push(file.originalPath);
            if (!requested.has(file.originalPath))
              removePaths.push(file.originalPath);
          }
        }
        await this.requireTerminalForHooks(root, "commit");
        const lockPath = indexPath! + ".lock";
        let lock: number;
        try {
          lock = openSync(lockPath, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw problem(409, "Индекс Git занят другой операцией", "GIT_BUSY");
          throw error;
        }
        let temp: string | undefined;
        try {
          temp = mkdtempSync(join(gitDir!, "miracle-commit-"));
          const commitIndex = join(temp, "commit-index"),
            nextIndex = join(temp, "next-index");
          const commitEnv = { GIT_INDEX_FILE: commitIndex },
            nextEnv = { GIT_INDEX_FILE: nextIndex };
          await this.run(["read-tree", status.head || "--empty"], root, {
            env: commitEnv,
          });
          if (addPaths.length)
            await this.run(["add", "-A", "--", ...addPaths], root, {
              env: commitEnv,
            });
          if (removePaths.length)
            await this.run(
              ["update-index", "--force-remove", "--", ...removePaths],
              root,
              { env: commitEnv },
            );
          const changed = (
            await this.run(
              ["diff", "--cached", "--no-renames", "--name-only", "-z"],
              root,
              { env: commitEnv },
            )
          )
            .split("\0")
            .filter(Boolean);
          if (!changed.length)
            throw problem(
              409,
              "Текущее содержимое выбранных файлов уже сохранено в HEAD",
              "GIT_NOTHING_TO_COMMIT",
            );
          if (
            changed.some(
              (path) => !selected.includes(path) || !this.safePath(root, path),
            )
          )
            throw problem(
              409,
              "Git добавил пути вне выбранных файлов. Выполните коммит в терминале",
              "GIT_SELECTION_CHANGED",
            );
          if (existsSync(indexPath!)) copyFileSync(indexPath!, nextIndex);
          else await this.run(["read-tree", "--empty"], root, { env: nextEnv });
          await this.run(
            ["update-index", "--force-remove", "--", ...selected],
            root,
            { env: nextEnv },
          );
          const entries = await this.run(
            ["ls-files", "--stage", "-z", "--", ...selected],
            root,
            { env: commitEnv },
          );
          if (entries)
            await this.run(["update-index", "-z", "--index-info"], root, {
              env: nextEnv,
              input: entries,
            });
          // Prepare replacement before advancing HEAD. The real index remains
          // untouched on failure; unrelated staged entries retain their blobs.
          writeFileSync(lock, readFileSync(nextIndex));
          const latest = await this.snapshot();
          if (latest.status.revision !== input.revision)
            throw problem(
              409,
              "Файлы или состояние Git изменились. Обновите список изменений",
              "GIT_STALE",
            );
          this.options.assertCanMutate?.();
          await this.run(["commit", "--file=-"], root, {
            env: commitEnv,
            input: input.message,
          });
          renameSync(lockPath, indexPath!);
        } finally {
          closeSync(lock!);
          rmSync(lockPath, { force: true });
          if (temp) rmSync(temp, { recursive: true, force: true });
        }
        return this.status();
      },
    );
  }
}
