import type { ReactElement } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  FilePlus,
  FolderPlus,
  ArrowRight,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react";
import type { ProjectTreeEntry } from "../../shared/project-files";

export type ProjectFileAction = "rename" | "move" | "delete";
export type ProjectMenuAction =
  ProjectFileAction | "new-file" | "new-directory";

export default function ProjectFileContextMenu({
  children,
  entry,
  busy,
  locked,
  canMove,
  canDelete,
  onAction,
  onCloseAutoFocus,
}: {
  children: ReactElement;
  entry: ProjectTreeEntry | null;
  busy: boolean;
  locked: boolean;
  canMove: boolean;
  canDelete: boolean;
  onAction: (action: ProjectMenuAction) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const folder = !entry || entry.kind === "directory";
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="dropdown-menu project-context-menu"
          collisionPadding={8}
          aria-label="Действия с файлами"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <ContextMenu.Label className="project-menu-label">
            {entry?.name || "Корень проекта"}
          </ContextMenu.Label>
          {folder && (
            <>
              <ContextMenu.Item
                disabled={busy || locked}
                onSelect={() => onAction("new-file")}
              >
                <FilePlus size={16} />
                Новый файл
              </ContextMenu.Item>
              <ContextMenu.Item
                disabled={busy || locked}
                onSelect={() => onAction("new-directory")}
              >
                <FolderPlus size={16} />
                Новая папка
              </ContextMenu.Item>
              {entry && (
                <ContextMenu.Separator className="project-menu-separator" />
              )}
            </>
          )}
          {entry && (
            <>
              <ContextMenu.Item
                disabled={busy || locked || !canMove}
                onSelect={() => onAction("rename")}
              >
                <PencilSimple size={16} />
                Переименовать<span className="project-menu-shortcut">F2</span>
              </ContextMenu.Item>
              <ContextMenu.Item
                disabled={busy || locked || !canMove}
                onSelect={() => onAction("move")}
              >
                <ArrowRight size={16} />
                Переместить…
              </ContextMenu.Item>
              <ContextMenu.Separator className="project-menu-separator" />
              <ContextMenu.Item
                className="project-menu-delete"
                disabled={busy || locked || !canDelete}
                onSelect={() => onAction("delete")}
              >
                <Trash size={16} />
                Удалить…
              </ContextMenu.Item>
            </>
          )}
          {locked && (
            <ContextMenu.Label className="project-menu-hint">
              С объектом работает агент
            </ContextMenu.Label>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
