export interface ProjectGitButtonProps {
  workspaceId: string;
  hasUnsavedFiles: boolean;
  onBeforeMutation?: () => Promise<void>;
  onBranchChanged?: () => Promise<void>;
  onNotify: (message: string, type?: "error" | "success" | "info") => void;
}

export type ProjectGitEditorState = Required<
  Pick<
    ProjectGitButtonProps,
    "hasUnsavedFiles" | "onBeforeMutation" | "onBranchChanged"
  >
>;

export default function ProjectGitButton(props: ProjectGitButtonProps) {
  return <ProjectGitControl key={props.workspaceId} {...props} />;
}

function ProjectGitControl(props: ProjectGitButtonProps) {
  const opener = useRef<HTMLButtonElement | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const git = useProjectGit(props.workspaceId, async () => {
    try {
      await latestProps.current.onBranchChanged?.();
    } catch (error) {
      latestProps.current.onNotify(
        error instanceof Error
          ? error.message
          : "Не удалось обновить файлы после смены ветки",
        "error",
      );
    }
  });
  const [open, setOpen] = useState(false);
  const ready = git.status?.state === "ready";
  const branch = ready
    ? git.status!.branch || `HEAD ${git.status!.head?.slice(0, 7) || ""}`
    : git.loading && !git.status
      ? "Git…"
      : "Git";
  async function run(action: GitAction, body: Record<string, unknown>) {
    const succeeded = await git.mutate(
      action,
      body,
      async () => {
        if (latestProps.current.hasUnsavedFiles)
          throw new Error("Сначала сохраните несохранённые файлы редактора.");
        await latestProps.current.onBeforeMutation?.();
      },
      action === "commit"
        ? undefined
        : () => latestProps.current.onBranchChanged?.() || Promise.resolve(),
    );
    if (succeeded)
      latestProps.current.onNotify(
        action === "commit" ? "Коммит создан" : "Ветка переключена",
        "success",
      );
    return succeeded;
  }
  return (
    <>
      <IconButton
        label="Git проекта"
        className={`git-trigger${open ? " active" : ""}`}
        title={
          git.error ||
          (ready
            ? `Git проекта · ${branch} · изменений: ${git.status!.files.length} · ${git.status!.isWorktree ? "Связанный worktree" : "Основное рабочее дерево"}`
            : git.status?.message ||
              (git.loading ? "Загружаем Git проекта…" : "Git проекта"))
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          opener.current = event.currentTarget;
          setOpen(true);
          void git.refresh();
        }}
      >
        {git.error ? <WarningCircle size={21} /> : <GitBranch size={21} />}
        {ready && git.status!.files.length > 0 && (
          <span className="git-trigger-count" aria-hidden="true">
            {git.status!.files.length > 99 ? "99+" : git.status!.files.length}
          </span>
        )}
      </IconButton>
      <ProjectGitDialog
        open={open}
        onOpenChange={setOpen}
        onRestoreFocus={() => opener.current?.focus()}
        git={git}
        hasUnsavedFiles={props.hasUnsavedFiles}
        run={run}
      />
    </>
  );
}
import { useRef, useState } from "react";
import { GitBranch, WarningCircle } from "@phosphor-icons/react";
import { IconButton } from "../components/UI";
import ProjectGitDialog from "./ProjectGitDialog";
import { useProjectGit, type GitAction } from "./useProjectGit";
import "./project-git.css";
