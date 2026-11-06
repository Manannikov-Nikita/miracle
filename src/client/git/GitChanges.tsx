import { useEffect, useState } from "react";
import { CheckCircle, GitCommit } from "@phosphor-icons/react";
import type { GitFile, GitStatus } from "../../shared/project-git";
import GitDiffView from "./GitDiffView";
import { Spinner } from "../components/UI";

function fileStatus(file: GitFile) {
  if (file.conflicted) return "Конфликт";
  if (file.indexStatus === "?" || file.worktreeStatus === "?") return "Новый";
  const descriptions: Record<string, string> = {
    M: "Изменён",
    A: "Добавлен",
    D: "Удалён",
    R: "Переименован",
    C: "Скопирован",
    T: "Изменён тип",
  };
  return (
    descriptions[file.worktreeStatus.trim()] ||
    descriptions[file.indexStatus.trim()] ||
    "Изменён"
  );
}

export default function GitChanges({
  status,
  selected,
  onSelectedChange,
  message,
  onMessageChange,
  disabled,
  busy,
  open,
  onCommit,
}: {
  status: GitStatus;
  selected: string[];
  onSelectedChange: (paths: string[]) => void;
  message: string;
  onMessageChange: (message: string) => void;
  disabled: boolean;
  busy: boolean;
  open: boolean;
  onCommit: () => Promise<void>;
}) {
  const [activePath, setActivePath] = useState<string | null>(null);
  const hasConflicts = status.counts.conflicted > 0;
  useEffect(() => {
    if (activePath && !status.files.some((file) => file.path === activePath))
      setActivePath(null);
  }, [status.files, activePath]);
  return (
    <div className="git-changes">
      {hasConflicts && (
        <p className="git-notice">
          Сначала разрешите конфликты Git в терминале. После этого обновите
          список изменений.
        </p>
      )}
      <div className="git-change-counts">
        <span>
          В индексе <strong>{status.counts.staged}</strong>
        </span>
        <span>
          На диске <strong>{status.counts.unstaged}</strong>
        </span>
        <span>
          Новые <strong>{status.counts.untracked}</strong>
        </span>
        {status.counts.conflicted > 0 && (
          <span className="error-text">
            Конфликты <strong>{status.counts.conflicted}</strong>
          </span>
        )}
      </div>
      {status.files.length ? (
        <div className="git-change-browser">
          <ul className="git-file-list" aria-label="Изменённые файлы">
            {status.files.map((file) => (
              <li
                key={file.path}
                className={file.path === activePath ? "active" : ""}
              >
                <input
                  type="checkbox"
                  aria-label={`Включить ${file.path} в коммит`}
                  checked={selected.includes(file.path)}
                  disabled={disabled || file.conflicted}
                  onChange={(event) =>
                    onSelectedChange(
                      event.target.checked
                        ? [...selected, file.path]
                        : selected.filter((path) => path !== file.path),
                    )
                  }
                />
                <button
                  type="button"
                  aria-label={`Посмотреть изменения ${file.path}`}
                  aria-pressed={file.path === activePath}
                  onClick={() => setActivePath(file.path)}
                  title={
                    file.originalPath
                      ? `${file.originalPath} → ${file.path}`
                      : file.path
                  }
                >
                  <span className="git-file-name">{file.path}</span>
                  <span
                    className={`git-file-status${file.conflicted ? " error-text" : ""}`}
                  >
                    {fileStatus(file)}
                    {file.indexStatus.trim() && file.indexStatus !== "?"
                      ? " · в индексе"
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <GitDiffView
            path={activePath}
            revision={status.revision}
            open={open}
          />
        </div>
      ) : (
        <div className="git-empty git-clean" role="status">
          <CheckCircle size={24} />
          <strong>Нет изменений</strong>
          <p>Все файлы рабочего дерева соответствуют последнему коммиту.</p>
        </div>
      )}
      <form
        className="git-commit"
        onSubmit={(event) => {
          event.preventDefault();
          void onCommit();
        }}
      >
        <label>
          Сообщение коммита
          <textarea
            aria-label="Сообщение коммита"
            rows={2}
            placeholder="Что изменилось и зачем"
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            disabled={busy}
            maxLength={10_000}
          />
        </label>
        <div className="git-commit-footer">
          <p>
            В коммит войдёт полное содержимое выбранных файлов на диске, включая
            изменения вне индекса. Выбор отдельных строк не поддерживается.
          </p>
          <button
            type="submit"
            className="button primary"
            disabled={
              disabled || hasConflicts || !selected.length || !message.trim()
            }
          >
            {busy ? <Spinner /> : <GitCommit size={17} />}Коммит выбранных
          </button>
        </div>
        <span className="git-selection-count" aria-live="polite">
          Выбрано файлов: {selected.length}
        </span>
      </form>
    </div>
  );
}
