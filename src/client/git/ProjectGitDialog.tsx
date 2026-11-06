import { useEffect, useState } from "react";
import { ArrowsClockwise, GitBranch } from "@phosphor-icons/react";
import { ErrorBox, IconButton, Modal, Spinner } from "../components/UI";
import GitChanges from "./GitChanges";
import { GitBranches, GitWorktrees } from "./GitBranches";
import type { GitAction, ProjectGitState } from "./useProjectGit";

export default function ProjectGitDialog({
  open,
  onOpenChange,
  onRestoreFocus,
  git,
  hasUnsavedFiles,
  run,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onRestoreFocus: () => void;
  git: ProjectGitState;
  hasUnsavedFiles: boolean;
  run: (action: GitAction, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [section, setSection] = useState("changes");
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const { status, busy, loading, error } = git;
  const ready = status?.state === "ready";
  const blocked = hasUnsavedFiles
    ? "В редакторе есть несохранённые файлы. Сохраните их перед операциями Git."
    : ready && !status.canMutate
      ? status.mutationBlockedReason || "Изменения Git сейчас недоступны."
      : "";
  const disabled = busy || !!blocked || !!error;
  useEffect(() => {
    setSelected((paths) =>
      paths.filter((path) => status?.files.some((file) => file.path === path)),
    );
  }, [status]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onRestoreFocus();
      }}
      title="Git проекта"
      description="Локальные ветки, изменения файлов и рабочие деревья."
      className="project-git-dialog"
      dismissible={!busy}
      wide
    >
      <div className="git-overview">
        <div className="git-repository">
          <strong>
            <GitBranch size={17} />
            {ready ? status.branch || "Detached HEAD" : "Git"}
          </strong>
          <span
            className="git-root"
            title={status?.root || status?.projectRoot}
          >
            {status?.root || status?.projectRoot || "Папка проекта"}
          </span>
          {ready && (
            <span className="git-head">
              {status.unborn
                ? "Первый коммит ещё не создан"
                : status.head?.slice(0, 7)}
              {status.isWorktree && " · Связанный worktree"}
            </span>
          )}
        </div>
        <IconButton
          label="Обновить Git"
          disabled={busy || loading}
          onClick={() => void git.refresh()}
        >
          <ArrowsClockwise size={17} className={loading ? "spin" : ""} />
        </IconButton>
      </div>
      <p className="git-storage-note">
        Git отслеживает файлы проекта. Хранящиеся в базе сохранённые запросы,
        доски и презентации не входят в коммиты.
      </p>
      {error && (
        <ErrorBox>
          <span>{error}</span>
        </ErrorBox>
      )}
      {blocked && (
        <p className="git-notice" role="status">
          {blocked}
        </p>
      )}
      {!status && (
        <div className="git-empty" role="status">
          {loading ? (
            <>
              <Spinner /> Проверяем Git…
            </>
          ) : (
            "Не удалось загрузить состояние Git. Попробуйте обновить."
          )}
        </div>
      )}
      {status && !ready && (
        <div className="git-empty" role="status">
          <strong>
            {status.state === "not_repository"
              ? "В папке проекта нет Git-репозитория"
              : "Git недоступен"}
          </strong>
          <p>
            {status.message ||
              (status.state === "not_repository"
                ? "Откройте проект с существующим Git-репозиторием."
                : "Установите Git и перезапустите Miracle.")}
          </p>
        </div>
      )}
      {ready && (
        <>
          <nav className="git-sections" aria-label="Разделы Git">
            {[
              ["changes", "Изменения"],
              ["branches", "Ветки"],
              ["worktrees", "Worktree"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={section === value}
                onClick={() => setSection(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          {section === "changes" && (
            <GitChanges
              status={status}
              selected={selected}
              onSelectedChange={setSelected}
              message={message}
              onMessageChange={setMessage}
              disabled={disabled}
              busy={busy}
              open={open}
              onCommit={async () => {
                if (
                  !selected.length ||
                  !message.trim() ||
                  disabled ||
                  status.counts.conflicted > 0
                )
                  return;
                if (
                  await run("commit", {
                    paths: selected,
                    message: message.trim(),
                  })
                ) {
                  setSelected([]);
                  setMessage("");
                }
              }}
            />
          )}
          {section === "branches" && (
            <GitBranches status={status} disabled={disabled} run={run} />
          )}
          {section === "worktrees" && <GitWorktrees status={status} />}
        </>
      )}
    </Modal>
  );
}
