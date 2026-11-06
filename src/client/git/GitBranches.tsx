import { useState } from "react";
import { ArrowRight, GitBranch, TreeStructure } from "@phosphor-icons/react";
import type { GitStatus } from "../../shared/project-git";
import type { GitAction } from "./useProjectGit";

export function GitBranches({
  status,
  disabled,
  run,
}: {
  status: GitStatus;
  disabled: boolean;
  run: (action: GitAction, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const dirty = status.files.length > 0;
  const blocked = disabled || dirty || status.unborn;
  return (
    <div className="git-branches">
      {status.unborn && (
        <p className="git-notice">
          Сначала создайте первый коммит в текущей ветке.
        </p>
      )}
      {dirty && (
        <p className="git-notice">
          Для переключения веток рабочее дерево должно быть чистым. Сначала
          сохраните изменения в коммит.
        </p>
      )}
      <form
        className="git-branch-create"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            !blocked &&
            name.trim() &&
            (await run("branches", { name: name.trim() }))
          )
            setName("");
        }}
      >
        <label>
          Новая ветка
          <input
            aria-label="Имя новой ветки"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="feature/my-change"
            disabled={blocked}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button
          type="submit"
          className="button"
          disabled={blocked || !name.trim()}
        >
          <GitBranch size={16} />
          Создать и переключиться
        </button>
      </form>
      <ul className="git-branch-list" aria-label="Локальные ветки">
        {status.branches.map((branch) => (
          <li key={branch.name}>
            <div>
              <strong>
                <GitBranch size={16} />
                {branch.name}
              </strong>
              {branch.current ? (
                <span>Текущая ветка</span>
              ) : branch.worktreePath ? (
                <span title={branch.worktreePath}>
                  Занята в worktree: {branch.worktreePath}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="button"
              aria-label={`Переключиться на ${branch.name}`}
              disabled={blocked || branch.current || !!branch.worktreePath}
              onClick={() => void run("switch", { branch: branch.name })}
            >
              <ArrowRight size={16} />
              <span>Переключиться</span>
            </button>
          </li>
        ))}
      </ul>
      {!status.branches.length && (
        <div className="git-empty">
          Локальных веток пока нет. Создайте первый коммит, чтобы сохранить
          текущую ветку.
        </div>
      )}
    </div>
  );
}

export function GitWorktrees({ status }: { status: GitStatus }) {
  return (
    <div className="git-worktrees">
      <p className="muted">
        Рабочие деревья этого репозитория. Чтобы работать в другом worktree,
        откройте его папку как проект Miracle.
      </p>
      <ul aria-label="Рабочие деревья">
        {status.worktrees.map((worktree) => (
          <li key={worktree.path}>
            <TreeStructure size={19} />
            <div>
              <strong>
                {worktree.branch || "Detached HEAD"}
                {worktree.current && (
                  <span className="git-current-badge">Текущий</span>
                )}
              </strong>
              <code>{worktree.path}</code>
              {(worktree.locked || worktree.prunable) && (
                <span className="muted">
                  {worktree.locked ? "Заблокирован" : "Недоступен на диске"}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
