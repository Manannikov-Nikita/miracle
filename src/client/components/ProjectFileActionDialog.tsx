import { useEffect, useRef, useState } from "react";
import {
  CaretRight,
  Folder,
  House,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ProjectTree, ProjectTreeEntry } from "../../shared/project-files";
import { api } from "../api";
import { Modal } from "./UI";
import type { ProjectFileAction } from "./ProjectFileContextMenu";

export interface ProjectFileOperation {
  action: Exclude<ProjectFileAction, "rename">;
  entry: ProjectTreeEntry;
}
const parentPath = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

function FolderPicker({
  entry,
  directory,
  onChange,
  onReady,
}: {
  entry: ProjectTreeEntry;
  directory: string;
  onChange: (path: string) => void;
  onReady: (ready: boolean) => void;
}) {
  const [tree, setTree] = useState<ProjectTree>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTree(undefined);
    setError("");
    onReady(false);
    void api<ProjectTree>(
      `/api/project/tree?path=${encodeURIComponent(directory)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setTree(result);
          onReady(true);
        }
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [directory, retry, onReady]);
  const folders = tree?.entries.filter(
    (item) =>
      item.kind === "directory" &&
      !(
        entry.kind === "directory" &&
        (item.path === entry.path || item.path.startsWith(`${entry.path}/`))
      ),
  );
  return (
    <div className="project-folder-picker">
      <nav className="project-folder-breadcrumbs" aria-label="Папка назначения">
        <button
          type="button"
          onClick={() => onChange("")}
          aria-current={directory === "" ? "location" : undefined}
        >
          <House size={14} />
          Корень проекта
        </button>
        {directory
          .split("/")
          .filter(Boolean)
          .map((part, index, parts) => (
            <span key={index}>
              <CaretRight size={12} aria-hidden="true" />
              <button
                type="button"
                onClick={() => onChange(parts.slice(0, index + 1).join("/"))}
                aria-current={
                  index === parts.length - 1 ? "location" : undefined
                }
              >
                {part}
              </button>
            </span>
          ))}
      </nav>
      <div
        className="project-destination-folders"
        aria-label="Папки назначения"
        aria-busy={!tree && !error}
      >
        {!tree && !error && (
          <p className="project-tree-note" role="status">
            Загрузка папок…
          </p>
        )}
        {error && (
          <p className="project-tree-note" role="alert">
            {error}{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Повторить
            </button>
          </p>
        )}
        {folders?.map((folder) => (
          <button
            type="button"
            key={folder.path}
            data-folder-path={folder.path}
            className="project-destination-folder"
            onClick={() => onChange(folder.path)}
          >
            <Folder size={17} />
            <span>{folder.name}</span>
            <CaretRight size={14} />
          </button>
        ))}
        {tree && !folders?.length && (
          <p className="project-tree-note">
            Вложенных папок нет. Можно переместить сюда.
          </p>
        )}
        {tree?.truncated && (
          <p className="project-tree-note">Показана часть содержимого папки.</p>
        )}
      </div>
    </div>
  );
}

export default function ProjectFileActionDialog({
  operation,
  onClose,
  onConfirm,
  onRestoreFocus,
}: {
  operation: ProjectFileOperation;
  onClose: () => void;
  onConfirm: (operation: ProjectFileOperation, value: string) => Promise<void>;
  onRestoreFocus: () => void;
}) {
  const { action, entry } = operation;
  const [value, setValue] = useState(parentPath(entry.path));
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(action !== "move");
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const title =
    action === "move"
      ? "Переместить"
      : entry.kind === "directory"
        ? "Удалить папку?"
        : "Удалить файл?";
  const invalidMove =
    action === "move" && (!ready || value === parentPath(entry.path));
  async function submit() {
    if (busyRef.current || invalidMove) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm(operation, value);
      if (alive.current) onClose();
    } catch (error) {
      if (alive.current) setError((error as Error).message);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={title}
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="project-file-dialog"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        formRef.current
          ?.querySelector<HTMLButtonElement>(
            action === "delete"
              ? 'button[type="button"]'
              : ".project-folder-breadcrumbs button",
          )
          ?.focus();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onRestoreFocus();
      }}
    >
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="project-operation-path" title={entry.path}>
          {entry.path}
        </p>
        {action === "move" && (
          <fieldset disabled={busy} className="project-move-fieldset">
            <legend>Выберите папку назначения</legend>
            <FolderPicker
              entry={entry}
              directory={value}
              onChange={setValue}
              onReady={setReady}
            />
          </fieldset>
        )}
        {action === "delete" && (
          <div className="project-delete-explanation">
            <WarningCircle size={20} aria-hidden="true" />
            <div>
              <p>
                {entry.kind === "directory"
                  ? "Папка будет удалена с диска вместе со всем содержимым."
                  : "Файл будет удалён с диска."}
              </p>
              <p className="muted">
                Открытые файлы останутся в редакторе как черновики — их можно
                будет скачать.
              </p>
            </div>
          </div>
        )}
        {error && (
          <p
            id="project-operation-error"
            className="project-operation-error"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            autoFocus={action === "delete"}
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </button>
          <button
            type="submit"
            className={`button ${action === "delete" ? "danger" : "primary"}`}
            disabled={busy || invalidMove}
          >
            {busy
              ? action === "delete"
                ? "Удаление…"
                : "Сохранение…"
              : action === "delete"
                ? "Удалить"
                : title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
