import { useEffect, useId, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowElbowDownLeft,
  Code,
  FileMd,
  FileText,
  MagnifyingGlass,
  ProjectorScreen,
  SquaresFour,
  X,
} from "@phosphor-icons/react";
import {
  MAX_SQL_FILE_CHARACTERS,
  type ProjectTextFile,
} from "../../shared/project-files";
import type { QueryDocument } from "../../shared/types";
import {
  SEARCH_GROUPS,
  type SearchGroupKey,
  type SearchResponse,
  type SearchResult,
  type SearchTarget,
} from "../../shared/workspace-search";
import { api } from "../api";
import { useCanvasWorkspace } from "../canvas-workspace";
import { IconButton, Spinner } from "./UI";
import "./workspace-search.css";

export type SearchNavigation = {
  requestId: string;
  target: Extract<SearchTarget, { kind: "file" | "query" }>;
};
const labels: Record<SearchGroupKey, string> = {
  boards: "Доски",
  presentations: "Презентации",
  sql: "SQL",
  markdown: "Markdown",
  files: "Другие файлы",
};
const icons = {
  boards: SquaresFour,
  presentations: ProjectorScreen,
  sql: Code,
  markdown: FileMd,
  files: FileText,
};

export default function WorkspaceSearch({
  workspaceId,
  open,
  onOpenChange,
  onOpenFile,
  onOpenQuery,
  onNavigate,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (file: ProjectTextFile, navigation: SearchNavigation) => void;
  onOpenQuery: (query: QueryDocument, navigation: SearchNavigation) => void;
  onNavigate?: () => void;
}) {
  const canvas = useCanvasWorkspace();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const searchRequest = useRef<AbortController | null>(null);
  const navigation = useRef<AbortController | null>(null);
  const pendingOpen = useRef<(() => void) | null>(null);
  const successfulClose = useRef(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const [active, setActive] = useState(0);
  const [activeType, setActiveType] = useState<SearchGroupKey | "all">("all");
  const [retry, setRetry] = useState(0);
  const trimmed = query.trim();
  const groups = SEARCH_GROUPS.flatMap(
    (type) =>
      response?.groups.filter(
        (group) => group.type === type && group.items.length,
      ) || [],
  );
  const currentItems = response?.query === trimmed && !pending;
  const tabs = [
    {
      type: "all" as const,
      label: "Все",
      total: groups.reduce((sum, group) => sum + group.total, 0),
    },
    ...(currentItems
      ? groups.map((group) => ({
          type: group.type,
          label: labels[group.type],
          total: group.total,
        }))
      : []),
  ];
  const visibleGroups = groups.filter(
    (group) => activeType === "all" || group.type === activeType,
  );
  const items = visibleGroups
    .flatMap((group) => group.items)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  const changeType = (type: SearchGroupKey | "all", focusTab = false) => {
    if (opening) return;
    setActiveType(type);
    setActive(0);
    if (results.current) results.current.scrollTop = 0;
    if (focusTab) document.getElementById(`${id}-tab-${type}`)?.focus();
  };
  const stepType = (direction: number, focusTab = false) => {
    const index = tabs.findIndex((tab) => tab.type === activeType);
    changeType(
      tabs[(index + direction + tabs.length) % tabs.length].type,
      focusTab,
    );
  };

  useEffect(() => {
    document
      .getElementById(`${id}-tab-${activeType}`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeType, id]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.code !== "KeyK" ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing ||
        !workspaceId
      )
        return;
      const otherDialog = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]',
        ),
      ].some((element) => element !== dialog.current);
      if (otherDialog) return;
      event.preventDefault();
      event.stopPropagation();
      if (open) field.current?.focus();
      else onOpenChange(true);
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [open, onOpenChange, workspaceId]);

  useEffect(() => {
    navigation.current?.abort();
    pendingOpen.current = null;
    return () => {
      searchRequest.current?.abort();
      navigation.current?.abort();
    };
  }, [workspaceId]);

  useEffect(() => {
    searchRequest.current?.abort();
    setResponse(null);
    setError("");
    setActive(0);
    setActiveType("all");
    if (!open || !trimmed) {
      setPending(false);
      return;
    }
    const controller = new AbortController();
    searchRequest.current = controller;
    setPending(true);
    const timer = setTimeout(() => {
      void api<SearchResponse>(`/api/search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setResponse(value);
        })
        .catch((reason) => {
          if (!controller.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Не удалось выполнить поиск",
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed, workspaceId, retry]);

  useEffect(() => {
    if (currentItems)
      document
        .getElementById(`${id}-result-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, activeType, currentItems, id, response]);

  const changeOpen = (value: boolean) => {
    if (!value && !successfulClose.current) {
      navigation.current?.abort();
      pendingOpen.current = null;
    }
    if (value) {
      navigation.current?.abort();
      successfulClose.current = false;
      setQuery("");
      setOpening("");
      setError("");
    }
    onOpenChange(value);
  };

  // The rail and shortcut can open the controlled dialog directly.
  useEffect(() => {
    if (open) {
      navigation.current?.abort();
      successfulClose.current = false;
      setQuery("");
      setOpening("");
    }
  }, [open]);

  async function select(result: SearchResult) {
    if (!currentItems || opening) return;
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    setOpening(result.key);
    setError("");
    try {
      const target = result.target;
      const requestId = crypto.randomUUID();
      if (target.kind === "file") {
        const file = await api<ProjectTextFile>(
          `/api/project/file?path=${encodeURIComponent(target.path)}`,
          { signal: controller.signal },
        );
        if (
          /\.sql$/i.test(file.path) &&
          file.content.length > MAX_SQL_FILE_CHARACTERS
        ) {
          throw new Error(
            "SQL-файл превышает лимит редактора: 1 000 000 символов.",
          );
        }
        pendingOpen.current = () => {
          if (!controller.signal.aborted)
            onOpenFile(file, { requestId, target });
        };
      } else if (target.kind === "query") {
        const document = await api<QueryDocument>(
          `/api/queries/${encodeURIComponent(target.id)}`,
          { signal: controller.signal },
        );
        pendingOpen.current = () => {
          if (!controller.signal.aborted)
            onOpenQuery(document, { requestId, target });
        };
      } else {
        if (!canvas)
          throw new Error("Дождитесь загрузки рабочего пространства");
        await canvas.openSearchResult(target, { signal: controller.signal });
      }
      if (controller.signal.aborted) return;
      onNavigate?.();
      successfulClose.current = true;
      changeOpen(false);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось открыть документ",
        );
    } finally {
      if (!controller.signal.aborted) setOpening("");
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop workspace-search-backdrop" />
        <Dialog.Content
          ref={dialog}
          className="workspace-search-dialog"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current = document.activeElement as HTMLElement;
            field.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const commit = pendingOpen.current;
            pendingOpen.current = null;
            if (successfulClose.current) {
              if (commit) requestAnimationFrame(commit);
            } else if (previousFocus.current?.isConnected)
              previousFocus.current.focus();
          }}
        >
          <Dialog.Title className="workspace-search-sr-only">
            Поиск по проекту
          </Dialog.Title>
          <div className="workspace-search-input-row">
            <MagnifyingGlass size={24} aria-hidden="true" />
            <input
              ref={field}
              type="text"
              role="combobox"
              aria-label="Поиск по проекту"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-results`}
              aria-activedescendant={
                currentItems && items[active]
                  ? `${id}-result-${active}`
                  : undefined
              }
              placeholder="Поиск по проекту"
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                navigation.current?.abort();
                setOpening("");
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  !currentItems ||
                  !items.length ||
                  opening
                )
                  return;
                if (
                  (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.shiftKey &&
                  tabs.length > 1
                ) {
                  event.preventDefault();
                  stepType(event.key === "ArrowRight" ? 1 : -1);
                } else if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  setActive(
                    (index) =>
                      (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length,
                  );
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void select(items[active]);
                }
              }}
            />
            {pending && <Spinner />}
            <Dialog.Close asChild>
              <IconButton label="Закрыть поиск">
                <X size={20} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div
            className="workspace-search-tabs"
            role="tablist"
            aria-label="Типы документов"
          >
            {tabs.map((tab) => (
              <button
                key={tab.type}
                type="button"
                role="tab"
                id={`${id}-tab-${tab.type}`}
                aria-selected={activeType === tab.type}
                aria-controls={`${id}-panel`}
                aria-disabled={Boolean(opening)}
                tabIndex={activeType === tab.type ? 0 : -1}
                onClick={() => changeType(tab.type)}
                onKeyDown={(event) => {
                  if (
                    event.nativeEvent.isComposing ||
                    opening ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.altKey ||
                    event.shiftKey
                  )
                    return;
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    stepType(event.key === "ArrowRight" ? 1 : -1, true);
                  } else if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    changeType(
                      tabs[event.key === "Home" ? 0 : tabs.length - 1].type,
                      true,
                    );
                  } else if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowUp"
                  ) {
                    event.preventDefault();
                    setActive(
                      event.key === "ArrowDown"
                        ? 0
                        : Math.max(0, items.length - 1),
                    );
                    field.current?.focus();
                  }
                }}
              >
                <span>{tab.label}</span>
                {currentItems && (
                  <span className="workspace-search-tab-count">
                    {tab.total}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div
            className="workspace-search-panel"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-tab-${activeType}`}
          >
            <div
              ref={results}
              className="workspace-search-results"
              id={`${id}-results`}
              role="listbox"
              aria-label="Результаты поиска"
              aria-busy={pending || Boolean(opening)}
            >
              {error && (
                <div
                  className="workspace-search-message workspace-search-error"
                  role="alert"
                >
                  <strong>{error}</strong>
                  <button
                    className="button small"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    Повторить поиск
                  </button>
                </div>
              )}
              {!trimmed && (
                <div className="workspace-search-message">
                  <MagnifyingGlass
                    size={32}
                    weight="light"
                    aria-hidden="true"
                  />
                  <strong>Найдите нужный документ</strong>
                  <p>Введите название, путь или фрагмент текста.</p>
                  <span>Доски, презентации, SQL и файлы проекта</span>
                </div>
              )}
              {trimmed && pending && (
                <div className="workspace-search-message" role="status">
                  <span>Ищем в сохранённых документах…</span>
                </div>
              )}
              {response?.incomplete && (
                <p className="workspace-search-warning" role="status">
                  Не все документы удалось проверить. Результаты могут быть
                  неполными.
                </p>
              )}
              {trimmed &&
                !pending &&
                !error &&
                response &&
                !items.length &&
                !response.incomplete && (
                  <div className="workspace-search-message" role="status">
                    <strong>Ничего не найдено</strong>
                    <p>Попробуйте другое название или фрагмент текста.</p>
                  </div>
                )}
              {currentItems &&
                items.map((result, index) => {
                  const Icon = icons[result.group];
                  return (
                    <div
                      key={result.key}
                      id={`${id}-result-${index}`}
                      role="option"
                      aria-selected={active === index}
                      aria-disabled={Boolean(opening)}
                      className={`workspace-search-result${active === index ? " is-active" : ""}`}
                      onMouseMove={() => {
                        if (!opening) setActive(index);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void select(result)}
                    >
                      <Icon size={21} aria-hidden="true" />
                      <div className="workspace-search-result-copy">
                        <strong>{result.title}</strong>
                        <span className="workspace-search-result-path">
                          {result.subtitle}
                        </span>
                        {result.snippet && (
                          <p>
                            {result.snippet.text.slice(0, result.snippet.start)}
                            <mark>
                              {result.snippet.text.slice(
                                result.snippet.start,
                                result.snippet.end,
                              )}
                            </mark>
                            {result.snippet.text.slice(result.snippet.end)}
                          </p>
                        )}
                      </div>
                      {opening === result.key ? (
                        <Spinner />
                      ) : (
                        active === index && (
                          <ArrowElbowDownLeft
                            size={16}
                            className="workspace-search-enter"
                            aria-hidden="true"
                          />
                        )
                      )}
                    </div>
                  );
                })}
              {currentItems &&
                visibleGroups
                  .filter((group) => group.total > group.items.length)
                  .map((group) => (
                    <p key={group.type} className="workspace-search-limit">
                      {labels[group.type]}: показано {group.items.length} из{" "}
                      {group.total}. Уточните запрос.
                    </p>
                  ))}
            </div>
          </div>
          <div className="workspace-search-footer">
            <span>Поиск по сохранённым документам</span>
            <span>
              <kbd>← →</kbd> тип <kbd>↑ ↓</kbd> выбор <kbd>Enter</kbd> открыть{" "}
              <kbd>Esc</kbd> закрыть
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
