import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  CaretRight,
  Code,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Check,
  Plus,
  X,
} from "@phosphor-icons/react";
import type {
  MoveProjectFile,
  ProjectTextFile,
  ProjectTree,
  ProjectTreeEntry,
} from "../../shared/project-files";
import type {
  ProjectFileMover,
  ProjectFileDeleter,
} from "../project-file-drafts";
import ProjectFileContextMenu, {
  type ProjectFileAction,
  type ProjectMenuAction,
} from "./ProjectFileContextMenu";
import ProjectFileActionDialog, {
  type ProjectFileOperation,
} from "./ProjectFileActionDialog";
import { api } from "../api";
import { IconButton } from "./UI";
import { useAgentWorkLocks } from "../agents/useAgentWork";
import { AgentWorkIndicator } from "../agents/AgentWorkIndicator";
import "./project-files.css";

type DirectoryState = { tree?: ProjectTree; loading?: boolean; error?: string };
type SearchState = {
  files: string[];
  truncated: boolean;
  loading?: boolean;
  error?: string;
};

export default function ProjectFileTree({
  workspaceId,
  filter,
  revision,
  onOpenFile,
  onMoveFile,
  onDeleteFile,
  onNotify,
  onClearFilter,
  actionsTarget,
}: {
  workspaceId: string;
  filter: string;
  revision: number;
  onOpenFile: (file: ProjectTextFile) => void;
  onMoveFile?: ProjectFileMover;
  onDeleteFile?: ProjectFileDeleter;
  onNotify: (message: string, tone?: "error" | "success" | "info") => void;
  onClearFilter?: () => void;
  actionsTarget?: HTMLElement | null;
}) {
  const workLocks = useAgentWorkLocks();
  const treeRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const skipMenuFocus = useRef(false);
  const pendingTreeFocus = useRef(false);
  const [menuEntry, setMenuEntry] = useState<ProjectTreeEntry | null>(null);
  const [operation, setOperation] = useState<ProjectFileOperation | null>(null);
  const [renaming, setRenaming] = useState<ProjectTreeEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const within = (path: string, root: string) =>
    path === root || path.startsWith(`${root}/`);
  const locked = (path: string) =>
    workLocks.some(
      (work) => work.target.kind === "file" && within(work.target.id, path),
    );
  function restoreTreeFocus() {
    pendingTreeFocus.current = true;
    const target = treeRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    (target || treeRef.current)?.focus();
    if (target || !selected) pendingTreeFocus.current = false;
  }
  function beginOperation(entry: ProjectTreeEntry, action: ProjectFileAction) {
    if (movingRef.current || creatingRef.current || locked(entry.path)) return;
    if (
      (action === "delete" && !onDeleteFile) ||
      (action !== "delete" && !onMoveFile)
    )
      return;
    openRequest.current?.abort();
    setOpening("");
    cancelCreate();
    if (action === "rename") {
      setRenameName(entry.name);
      setRenameError("");
      setRenaming(entry);
    } else {
      setRenaming(null);
      setOperation({ entry, action });
    }
  }
  function menuAction(action: ProjectMenuAction) {
    skipMenuFocus.current = true;
    if (action === "new-file" || action === "new-directory") {
      startCreate(
        action === "new-file" ? "file" : "directory",
        menuEntry?.path || "",
      );
    } else if (menuEntry) beginOperation(menuEntry, action);
  }
  function contextTarget(entry: ProjectTreeEntry | null, target: HTMLElement) {
    skipMenuFocus.current = false;
    menuTrigger.current = target;
    select(entry?.path || "", entry?.kind !== "file");
    setMenuEntry(entry);
  }
  const storageKey = `miracle:project-tree:${workspaceId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(storageKey) || "[]",
      );
      return new Set(
        Array.isArray(saved)
          ? saved.filter((p): p is string => typeof p === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >({});
  const [selected, setSelected] = useState("");
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [createKind, setCreateKind] = useState<"file" | "directory">("file");
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [draggedFile, setDraggedFile] = useState<string | null>(null);
  const draggedFileRef = useRef<string | null>(null);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const movingRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [opening, setOpening] = useState("");
  const [searchResult, setSearchResult] = useState<SearchState>({
    files: [],
    truncated: false,
  });
  const requests = useRef(new Map<string, AbortController>());
  const openRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const selectionRevision = useRef(0);
  const search = filter.trim();

  useEffect(() => {
    if (!pendingTreeFocus.current || operation || moving || renaming) return;
    const target = treeRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    if (
      target ||
      !selected ||
      !Object.values(directories).some((state) => state.loading)
    ) {
      pendingTreeFocus.current = false;
      (target || treeRef.current)?.focus();
    }
  }, [directories, selected, operation, moving, renaming]);

  function focusRename() {
    if (!renaming) return;
    renameInput.current?.focus();
    const dot = renaming.kind === "file" ? renaming.name.lastIndexOf(".") : -1;
    renameInput.current?.setSelectionRange(
      0,
      dot > 0 ? dot : renaming.name.length,
    );
  }
  useEffect(focusRename, [renaming]);
  useEffect(() => {
    if (renameError && !moving) renameInput.current?.focus();
  }, [renameError, moving]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (creatingIn !== null) nameInput.current?.focus();
  }, [creatingIn, creating]);

  function select(path: string, isDirectory: boolean) {
    selectionRevision.current++;
    if (creatingIn !== null && !creatingRef.current) cancelCreate();
    if (renaming && renaming.path !== path && !movingRef.current)
      setRenaming(null);
    openRequest.current?.abort();
    setOpening("");
    setSelected(path);
    setSelectedDirectory(
      isDirectory ? path : path.slice(0, Math.max(0, path.lastIndexOf("/"))),
    );
  }

  function startCreate(
    kind: "file" | "directory" = "file",
    parent = selectedDirectory,
  ) {
    if (movingRef.current) return;
    setRenaming(null);
    if (creatingIn !== null) {
      nameInput.current?.focus();
      return;
    }
    openRequest.current?.abort();
    setOpening("");
    onClearFilter?.();
    const next = new Set(expanded);
    const segments = parent.split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      const path = segments.slice(0, index + 1).join("/");
      next.add(path);
      if (!directories[path]?.tree && !directories[path]?.loading)
        void load(path);
    }
    setExpanded(next);
    setNewName("");
    setCreateError("");
    setCreateKind(kind);
    setCreatingIn(parent);
  }

  function cancelCreate() {
    if (creatingRef.current) return;
    setCreatingIn(null);
    setCreateError("");
  }

  async function createFile() {
    if (creatingIn === null || creatingRef.current) return;
    if (
      !newName.trim() ||
      newName === "." ||
      newName === ".." ||
      /[/\\\u0000-\u001f\u007f]/.test(newName)
    ) {
      setCreateError(
        createKind === "directory"
          ? "Введите имя папки без разделителей пути"
          : "Введите имя файла без разделителей пути, например notes.md",
      );
      nameInput.current?.focus();
      return;
    }
    const directory = creatingIn;
    const selectionAtStart = selectionRevision.current;
    creatingRef.current = true;
    setCreating(true);
    setCreateError("");
    try {
      const file = await api<ProjectTextFile | ProjectTreeEntry>(
        `/api/project/${createKind}`,
        {
          method: "POST",
          body: JSON.stringify({ directory, name: newName }),
        },
      );
      if (!mounted.current) return;
      setCreatingIn(null);
      void load(directory);
      if (selectionRevision.current === selectionAtStart) {
        setSelected(file.path);
        setSelectedDirectory(
          createKind === "directory" ? file.path : directory,
        );
        if (createKind === "file") onOpenFile(file as ProjectTextFile);
        else {
          setExpanded((current) => new Set([...current, file.path]));
          void load(file.path);
        }
      } else
        onNotify(
          `${createKind === "directory" ? "Папка" : "Файл"} ${file.name} ${createKind === "directory" ? "создана" : "создан"}`,
          "success",
        );
    } catch (error) {
      if (mounted.current) setCreateError((error as Error).message);
    } finally {
      creatingRef.current = false;
      if (mounted.current) setCreating(false);
    }
  }

  function newFileRow(path: string, level: number) {
    if (creatingIn !== path) return null;
    const folder = createKind === "directory";
    return (
      <form
        className="project-create-file"
        noValidate
        onContextMenu={(event) => event.stopPropagation()}
        aria-label={`${folder ? "Новая папка" : "Новый файл"}: ${path || "корень проекта"}`}
        style={{ paddingLeft: 12 + (level - 1) * 14 + 18 }}
        onSubmit={(event) => {
          event.preventDefault();
          void createFile();
        }}
      >
        <div className="project-create-row">
          {folder ? (
            <Folder size={15} aria-hidden="true" />
          ) : (
            <FileText size={15} aria-hidden="true" />
          )}
          <input
            ref={nameInput}
            aria-label={folder ? "Имя новой папки" : "Имя нового файла"}
            placeholder={folder ? "имя папки" : "имя.ext"}
            value={newName}
            autoComplete="off"
            autoFocus
            autoCapitalize="off"
            spellCheck={false}
            disabled={creating}
            aria-invalid={!!createError}
            aria-describedby={createError ? "project-create-error" : undefined}
            onChange={(event) => {
              setNewName(event.target.value);
              setCreateError("");
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                cancelCreate();
              }
              if (event.key === "Enter" && event.nativeEvent.isComposing)
                event.preventDefault();
            }}
          />
          <IconButton
            label={
              folder
                ? "Создать папку с этим именем"
                : "Создать файл с этим именем"
            }
            onClick={() => void createFile()}
            disabled={creating}
          >
            {creating ? <span aria-hidden="true">…</span> : <Check size={13} />}
          </IconButton>
          <IconButton
            label={
              folder ? "Отменить создание папки" : "Отменить создание файла"
            }
            onClick={cancelCreate}
            disabled={creating}
          >
            <X size={13} />
          </IconButton>
        </div>
        {createError && (
          <p
            id="project-create-error"
            className="project-create-error"
            role="alert"
          >
            {createError}
          </p>
        )}
      </form>
    );
  }

  function cancelRename() {
    if (movingRef.current) return;
    setRenaming(null);
    setRenameError("");
    pendingTreeFocus.current = true;
  }

  async function submitRename() {
    if (!renaming || movingRef.current) return;
    if (
      !renameName.trim() ||
      renameName === "." ||
      renameName === ".." ||
      /[/\\\u0000-\u001f\u007f]/.test(renameName)
    ) {
      setRenameError("Введите имя без разделителей пути");
      renameInput.current?.focus();
      return;
    }
    if (renameName === renaming.name) {
      cancelRename();
      return;
    }
    setRenameError("");
    try {
      await performMove(renaming, {
        path: renaming.path,
        directory: renaming.path.slice(
          0,
          Math.max(0, renaming.path.lastIndexOf("/")),
        ),
        name: renameName,
      });
      if (mounted.current) {
        setRenaming(null);
        pendingTreeFocus.current = true;
      }
    } catch (error) {
      if (mounted.current) setRenameError((error as Error).message);
    }
  }

  function renameRow(entry: ProjectTreeEntry, level: number, fullPath = false) {
    const folder = entry.kind === "directory";
    const Icon = folder ? Folder : /\.sql$/i.test(entry.name) ? Code : FileText;
    return (
      <form
        key={entry.path}
        role="treeitem"
        aria-label={entry.name}
        aria-level={level}
        aria-selected={selected === entry.path}
        aria-expanded={folder ? expanded.has(entry.path) : undefined}
        aria-busy={!!moving}
        title={entry.path}
        className="project-rename-file selected"
        style={{
          paddingLeft: 12 + (level - 1) * 14 + (folder || fullPath ? 0 : 18),
        }}
        noValidate
        onContextMenu={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submitRename();
        }}
      >
        <div className="project-create-row">
          {folder && (
            <CaretRight
              size={12}
              className={expanded.has(entry.path) ? "expanded" : ""}
              aria-hidden="true"
            />
          )}
          <Icon size={15} aria-hidden="true" />
          <input
            ref={renameInput}
            aria-label="Новое имя"
            value={renameName}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={!!moving}
            aria-invalid={!!renameError}
            aria-describedby={renameError ? "project-rename-error" : undefined}
            onChange={(event) => {
              setRenameName(event.target.value);
              setRenameError("");
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                if (!event.nativeEvent.isComposing) void submitRename();
              }
            }}
          />
          <IconButton
            label="Применить имя"
            onClick={() => void submitRename()}
            disabled={!!moving}
          >
            {moving ? <span aria-hidden="true">…</span> : <Check size={13} />}
          </IconButton>
          <IconButton
            label="Отменить переименование"
            onClick={cancelRename}
            disabled={!!moving}
          >
            <X size={13} />
          </IconButton>
        </div>
        {renameError && (
          <p
            id="project-rename-error"
            className="project-create-error"
            role="alert"
          >
            {renameError}
          </p>
        )}
      </form>
    );
  }

  async function load(path: string) {
    requests.current.get(path)?.abort();
    const controller = new AbortController();
    requests.current.set(path, controller);
    const version = generation.current;
    setDirectories((state) => ({
      ...state,
      [path]: { ...state[path], loading: true, error: undefined },
    }));
    try {
      const tree = await api<ProjectTree>(
        `/api/project/tree?path=${encodeURIComponent(path)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && version === generation.current)
        setDirectories((state) => ({ ...state, [path]: { tree } }));
    } catch (error) {
      if (!controller.signal.aborted && version === generation.current)
        setDirectories((state) => ({
          ...state,
          [path]: { error: (error as Error).message },
        }));
    } finally {
      if (requests.current.get(path) === controller)
        requests.current.delete(path);
    }
  }

  useEffect(() => {
    generation.current++;
    requests.current.forEach((request) => request.abort());
    requests.current.clear();
    setDirectories({});
    void load("");
    expanded.forEach((path) => void load(path));
    return () => {
      generation.current++;
      requests.current.forEach((request) => request.abort());
      requests.current.clear();
    };
  }, [revision]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {}
  }, [storageKey, expanded]);
  useEffect(() => () => openRequest.current?.abort(), []);

  useEffect(() => {
    if (!search) return;
    const controller = new AbortController();
    setSearchResult({ files: [], truncated: false, loading: true });
    const timer = setTimeout(() => {
      void api<SearchState>(
        `/api/project/files?q=${encodeURIComponent(search)}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) setSearchResult(result);
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted)
            setSearchResult({
              files: [],
              truncated: false,
              error: error.message,
            });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, revision]);

  function toggle(path: string) {
    select(path, true);
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (!directories[path]?.tree && !directories[path]?.loading)
        void load(path);
    }
    setExpanded(next);
  }

  async function open(path: string) {
    if (renaming && !movingRef.current) setRenaming(null);
    selectionRevision.current++;
    openRequest.current?.abort();
    const controller = new AbortController();
    openRequest.current = controller;
    setSelected(path);
    setSelectedDirectory(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
    setOpening(path);
    try {
      const file = await api<ProjectTextFile>(
        `/api/project/file?path=${encodeURIComponent(path)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) onOpenFile(file);
    } catch (error) {
      if (!controller.signal.aborted)
        onNotify((error as Error).message, "error");
    } finally {
      if (!controller.signal.aborted) setOpening("");
    }
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (
      (event.target as HTMLElement).closest(
        "input, textarea, [contenteditable=true]",
      )
    )
      return;
    if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const target =
        (event.target as HTMLElement).closest<HTMLElement>(
          '[role="treeitem"]',
        ) || event.currentTarget;
      const bounds = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: bounds.left + 16,
          clientY: bounds.top + 16,
        }),
      );
      return;
    }
    if (event.key === "F2") {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        '[role="treeitem"]',
      );
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        beginOperation(
          {
            path: target.title,
            name: target.title.split("/").at(-1)!,
            kind: target.hasAttribute("aria-expanded") ? "directory" : "file",
          },
          "rename",
        );
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (creatingIn !== null) cancelCreate();
      else select("", true);
      event.currentTarget.focus();
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button[role=treeitem]",
    );
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button[role=treeitem]",
      ),
    ];
    if (!target) {
      const next =
        event.key === "ArrowDown" || event.key === "Home"
          ? items[0]
          : event.key === "ArrowUp" || event.key === "End"
            ? items.at(-1)
            : undefined;
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }
    const index = items.indexOf(target);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown")
      next = items[Math.min(index + 1, items.length - 1)];
    else if (event.key === "ArrowUp") next = items[Math.max(0, index - 1)];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "ArrowRight") {
      if (target.getAttribute("aria-expanded") === "false") target.click();
      else if (target.getAttribute("aria-expanded") === "true") {
        const candidate = items[index + 1];
        if (
          candidate &&
          Number(candidate.getAttribute("aria-level")) >
            Number(target.getAttribute("aria-level"))
        )
          next = candidate;
      }
    } else if (event.key === "ArrowLeft") {
      if (target.getAttribute("aria-expanded") === "true") target.click();
      else {
        const level = Number(target.getAttribute("aria-level"));
        next = items
          .slice(0, index)
          .reverse()
          .find((item) => Number(item.getAttribute("aria-level")) < level);
      }
    } else return;
    event.preventDefault();
    next?.focus();
  }

  function clearDrag() {
    draggedFileRef.current = null;
    setDraggedFile(null);
    setDropPath(null);
  }

  function refreshTree(nextExpanded: Set<string>) {
    generation.current++;
    requests.current.forEach((request) => request.abort());
    requests.current.clear();
    setDirectories({});
    setExpanded(nextExpanded);
    void load("");
    nextExpanded.forEach((path) => void load(path));
  }
  async function performMove(entry: ProjectTreeEntry, input: MoveProjectFile) {
    if (!onMoveFile || movingRef.current)
      throw new Error("Дождитесь завершения операции");
    const selectionAtStart = selectionRevision.current;
    movingRef.current = true;
    setMoving(input.path);
    openRequest.current?.abort();
    setOpening("");
    cancelCreate();
    try {
      const result = await onMoveFile(input);
      if (!mounted.current) return;
      onClearFilter?.();
      const nextExpanded = new Set(
        [...expanded].map((path) =>
          within(path, result.from)
            ? result.path + path.slice(result.from.length)
            : path,
        ),
      );
      const parts = input.directory.split("/").filter(Boolean);
      parts.forEach((_, index) =>
        nextExpanded.add(parts.slice(0, index + 1).join("/")),
      );
      refreshTree(nextExpanded);
      if (selectionRevision.current === selectionAtStart) {
        setSelected(result.path);
        setSelectedDirectory(
          entry.kind === "directory" ? result.path : input.directory,
        );
      }
      if (input.name)
        onNotify(
          `${entry.kind === "directory" ? "Папка" : "Файл"} ${result.name} ${entry.kind === "directory" ? "переименована" : "переименован"}`,
          "success",
        );
    } finally {
      movingRef.current = false;
      if (mounted.current) setMoving(null);
    }
  }
  async function moveFile(path: string, directory: string) {
    if (path.slice(0, Math.max(0, path.lastIndexOf("/"))) === directory) return;
    const entry = Object.values(directories)
      .flatMap((state) => state.tree?.entries || [])
      .find((entry) => entry.path === path) || {
      path,
      name: path.split("/").at(-1)!,
      kind: "file" as const,
    };
    try {
      await performMove(entry, { path, directory });
    } catch (error) {
      if (mounted.current) onNotify((error as Error).message, "error");
    }
  }
  async function confirmOperation(
    current: ProjectFileOperation,
    value: string,
  ) {
    const { entry, action } = current;
    if (action !== "delete") {
      await performMove(entry, {
        path: entry.path,
        directory: value,
      });
      return;
    }
    if (!onDeleteFile || movingRef.current)
      throw new Error("Дождитесь завершения операции");
    movingRef.current = true;
    setMoving(entry.path);
    openRequest.current?.abort();
    setOpening("");
    cancelCreate();
    try {
      const result = await onDeleteFile({ path: entry.path });
      if (!mounted.current) return;
      onClearFilter?.();
      refreshTree(
        new Set([...expanded].filter((path) => !within(path, result.path))),
      );
      if (within(selected, result.path)) {
        const parent = result.path.slice(
          0,
          Math.max(0, result.path.lastIndexOf("/")),
        );
        setSelected(parent);
        setSelectedDirectory(parent);
      }
      onNotify(
        `${entry.kind === "directory" ? "Папка" : "Файл"} ${entry.name} ${entry.kind === "directory" ? "удалена" : "удалён"}`,
        "success",
      );
    } finally {
      movingRef.current = false;
      if (mounted.current) setMoving(null);
    }
  }

  function isTreeBackground(target: EventTarget) {
    return (
      target instanceof Element &&
      !target.closest('[role="treeitem"], .project-create-file, button, input')
    );
  }

  function dropTarget(directory: string) {
    const accepts = (event: DragEvent<HTMLElement>) => {
      const path = draggedFileRef.current;
      return (
        !!path &&
        !movingRef.current &&
        !renaming &&
        !within(directory, path) &&
        (directory !== "" || isTreeBackground(event.target)) &&
        path.slice(0, Math.max(0, path.lastIndexOf("/"))) !== directory
      );
    };
    return {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        if (!accepts(event)) {
          if (draggedFileRef.current) setDropPath(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropPath(directory);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        if (!accepts(event)) {
          if (draggedFileRef.current) setDropPath(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropPath(directory);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDropPath(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        if (!accepts(event)) return;
        event.preventDefault();
        const path = draggedFileRef.current!;
        clearDrag();
        void moveFile(path, directory);
      },
    };
  }

  function fileRow(
    path: string,
    name: string,
    level: number,
    fullPath = false,
  ) {
    if (renaming?.path === path) return renameRow(renaming, level, fullPath);
    const Icon = /\.sql$/i.test(name) ? Code : FileText;
    const work = workLocks.find(
      (work) => work.target.kind === "file" && work.target.id === path,
    );
    return (
      <button
        type="button"
        role="treeitem"
        aria-level={level}
        aria-selected={selected === path}
        aria-busy={opening === path}
        disabled={moving === path}
        draggable={!!onMoveFile && !work && !moving && !creating && !renaming}
        onDragStart={(event) => {
          if (
            !onMoveFile ||
            work ||
            movingRef.current ||
            creatingRef.current ||
            renaming
          ) {
            event.preventDefault();
            return;
          }
          draggedFileRef.current = path;
          setDraggedFile(path);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            "application/x-miracle-project-file",
            path,
          );
        }}
        onDragEnd={clearDrag}
        key={path}
        title={path}
        className={`project-file-row ${selected === path ? "selected" : ""}${work ? " agent-work-active" : ""}`}
        style={{ paddingLeft: 12 + (level - 1) * 14 + (fullPath ? 0 : 18) }}
        onContextMenu={(event) =>
          contextTarget({ path, name, kind: "file" }, event.currentTarget)
        }
        onClick={() => void open(path)}
        onFocus={() => select(path, false)}
      >
        <Icon size={15} aria-hidden="true" />
        <span className="project-file-name">
          {name}
          {fullPath && path.includes("/") && (
            <small>{path.slice(0, path.lastIndexOf("/"))}</small>
          )}
        </span>
        <AgentWorkIndicator compact work={work} />
        {opening === path && (
          <span className="project-file-loading" aria-hidden="true">
            …
          </span>
        )}
      </button>
    );
  }

  function directory(path: string, level: number) {
    const state = directories[path];
    return (
      <>
        {newFileRow(path, level)}
        {state?.loading && !state.tree && (
          <p className="project-tree-note" role="status">
            Загрузка…
          </p>
        )}
        {state?.error && (
          <div className="project-tree-note" role="alert">
            {state.error}{" "}
            <button className="text-button" onClick={() => void load(path)}>
              Повторить
            </button>
          </div>
        )}
        {state?.tree?.entries.map((entry) =>
          entry.kind === "file" ? (
            fileRow(entry.path, entry.name, level)
          ) : (
            <div key={entry.path} role="none">
              {renaming?.path === entry.path ? (
                renameRow(entry, level)
              ) : (
                <button
                  type="button"
                  role="treeitem"
                  aria-level={level}
                  aria-expanded={expanded.has(entry.path)}
                  aria-selected={selected === entry.path}
                  className={`project-file-row project-folder-row ${selected === entry.path ? "selected" : ""}${dropPath === entry.path ? " project-drop-active" : ""}`}
                  {...dropTarget(entry.path)}
                  title={entry.path}
                  style={{ paddingLeft: 12 + (level - 1) * 14 }}
                  disabled={moving === entry.path}
                  draggable={
                    !!onMoveFile &&
                    !locked(entry.path) &&
                    !moving &&
                    !creating &&
                    !renaming
                  }
                  onDragStart={(event) => {
                    if (
                      !onMoveFile ||
                      locked(entry.path) ||
                      movingRef.current ||
                      creatingRef.current ||
                      renaming
                    ) {
                      event.preventDefault();
                      return;
                    }
                    draggedFileRef.current = entry.path;
                    setDraggedFile(entry.path);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(
                      "application/x-miracle-project-file",
                      entry.path,
                    );
                  }}
                  onDragEnd={clearDrag}
                  onContextMenu={(event) =>
                    contextTarget(entry, event.currentTarget)
                  }
                  onClick={() => toggle(entry.path)}
                  onFocus={() => select(entry.path, true)}
                >
                  <CaretRight
                    size={12}
                    className={expanded.has(entry.path) ? "expanded" : ""}
                    aria-hidden="true"
                  />
                  {expanded.has(entry.path) ? (
                    <FolderOpen size={15} aria-hidden="true" />
                  ) : (
                    <Folder size={15} aria-hidden="true" />
                  )}
                  <span className="project-file-name">{entry.name}</span>
                </button>
              )}
              {expanded.has(entry.path) && (
                <div role="group">{directory(entry.path, level + 1)}</div>
              )}
            </div>
          ),
        )}
        {state?.tree && !state.tree.entries.length && creatingIn !== path && (
          <p className="project-tree-note">
            {path ? "Папка пуста" : "В проекте пока нет файлов"}
          </p>
        )}
        {state?.tree?.truncated && (
          <p className="project-tree-note">
            Показана часть папки. Уточните имя в поиске.
          </p>
        )}
      </>
    );
  }

  const actions = (
    <>
      <IconButton
        label="Создать файл"
        title={`Создать файл: ${selectedDirectory || "корень проекта"}`}
        onClick={() => startCreate()}
        disabled={creating || !!moving}
      >
        <Plus size={14} />
      </IconButton>
      <IconButton
        label="Создать папку"
        title={`Создать папку: ${selectedDirectory || "корень проекта"}`}
        onClick={() => startCreate("directory")}
        disabled={creating || !!moving}
      >
        <FolderPlus size={14} />
      </IconButton>
    </>
  );

  return (
    <>
      {actionsTarget
        ? createPortal(actions, actionsTarget)
        : actionsTarget === undefined && (
            <div className="project-tree-actions">{actions}</div>
          )}
      <ProjectFileContextMenu
        entry={menuEntry}
        busy={creating || !!moving}
        locked={!!menuEntry && locked(menuEntry.path)}
        canMove={!!onMoveFile}
        canDelete={!!onDeleteFile}
        onAction={menuAction}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (renaming) focusRename();
          else if (!skipMenuFocus.current)
            (menuTrigger.current?.isConnected
              ? menuTrigger.current
              : treeRef.current
            )?.focus();
        }}
      >
        <div
          ref={treeRef}
          className={`project-file-tree${dropPath === "" ? " project-root-drop-active" : ""}`}
          role="tree"
          aria-label="Файлы проекта"
          tabIndex={0}
          {...dropTarget("")}
          onClick={(event) => {
            if (!isTreeBackground(event.target)) return;
            select("", true);
            event.currentTarget.focus();
          }}
          onContextMenu={(event) => {
            if (isTreeBackground(event.target))
              contextTarget(null, event.currentTarget);
          }}
          onKeyDown={navigate}
        >
          {search && creatingIn === null ? (
            <>
              {searchResult.loading && (
                <p className="project-tree-note" role="status">
                  Поиск…
                </p>
              )}
              {searchResult.error && (
                <p className="project-tree-note" role="alert">
                  {searchResult.error}
                </p>
              )}
              {searchResult.files.map((path) =>
                fileRow(path, path.split("/").at(-1)!, 1, true),
              )}
              {!searchResult.loading &&
                !searchResult.error &&
                !searchResult.files.length && (
                  <p className="project-tree-note" role="status">
                    Файлы не найдены
                  </p>
                )}
              {searchResult.truncated && (
                <p className="project-tree-note">
                  Показана часть результатов. Уточните поиск.
                </p>
              )}
            </>
          ) : (
            directory("", 1)
          )}
          {draggedFile?.includes("/") && (
            <p className="project-root-drop-hint">
              Переместить в корень проекта
            </p>
          )}
        </div>
      </ProjectFileContextMenu>
      {operation && (
        <ProjectFileActionDialog
          key={`${operation.action}:${operation.entry.path}`}
          operation={operation}
          onClose={() => setOperation(null)}
          onConfirm={confirmOperation}
          onRestoreFocus={restoreTreeFocus}
        />
      )}
    </>
  );
}
