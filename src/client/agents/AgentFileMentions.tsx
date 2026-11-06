import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChartLine, Code, FileText, X } from "@phosphor-icons/react";
import { api } from "../api";
import type { OpenEditorTab } from "./ProjectSync";

type Mention = { start: number; end: number; query: string };
function mentionAt(value: string, start: number, end: number): Mention | null {
  if (start !== end) return null;
  const match = /(?:^|[\s(])@([^\n@]*)$/.exec(value.slice(0, end));
  if (!match || match[1].length > 200) return null;
  return { start: end - match[1].length - 1, end, query: match[1] };
}
interface Props {
  draft: string;
  draftKey: string;
  onDraftChange: (value: string) => void;
  filePaths: string[];
  onFilesChange?: (paths: string[]) => void;
  editorTabs?: OpenEditorTab[];
  editorTarget?: OpenEditorTab;
  onEditorTargetChange?: (tab: OpenEditorTab | undefined) => void;
  onSubmit: () => void;
}
export default function AgentFileMentions({
  draft,
  draftKey,
  onDraftChange,
  filePaths,
  onFilesChange,
  editorTabs = [],
  editorTarget,
  onEditorTargetChange,
  onSubmit,
}: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState({ start: 0, end: 0 });
  const [dismissed, setDismissed] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    files: string[];
    truncated: boolean;
    error?: string;
  } | null>(null);
  const restoreCaret = useRef<number | null>(null);
  const listId = `agent-file-options-${useId()}`;
  const mention =
    focused && (onFilesChange || onEditorTargetChange)
      ? mentionAt(draft, caret.start, caret.end)
      : null;
  const key = mention
    ? `${draftKey}:${mention.start}:${mention.end}:${mention.query}`
    : "";
  const open = Boolean(mention && key !== dismissed);
  const full = filePaths.length >= 20;
  const current = result?.key === key ? result : null;
  const query = mention?.query.trim().toLocaleLowerCase() || "";
  const matchingTabs = editorTabs.filter(
    (tab) =>
      (tab.path
        ? !!onFilesChange && !full && !filePaths.includes(tab.path)
        : !!onEditorTargetChange && tab.id !== editorTarget?.id) &&
      `${tab.name} ${tab.path || ""}`.toLocaleLowerCase().includes(query),
  );
  const tabPaths = new Set(matchingTabs.map((tab) => tab.path));
  const files =
    full || !onFilesChange
      ? []
      : current?.files.filter(
          (path) => !filePaths.includes(path) && !tabPaths.has(path),
        ) || [];
  const options: (
    { tab: OpenEditorTab; path?: string } | { path: string; tab?: undefined }
  )[] = [
    ...matchingTabs.map((tab) => ({ tab, path: tab.path })),
    ...files.map((path) => ({ path })),
  ];
  const active = Math.min(selected, Math.max(0, options.length - 1));

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(180, Math.max(64, field.scrollHeight))}px`;
    if (restoreCaret.current !== null) {
      const position = restoreCaret.current;
      restoreCaret.current = null;
      field.focus();
      field.setSelectionRange(position, position);
      setCaret({ start: position, end: position });
    }
  }, [draft]);
  useEffect(() => {
    if (!open || full || !mention || !onFilesChange) return;
    const controller = new AbortController();
    let cancelled = false;
    setSelected(0);
    setResult(null);
    const timer = setTimeout(() => {
      void api<{ files: string[]; truncated: boolean }>(
        `/api/project/files?q=${encodeURIComponent(mention.query)}`,
        { signal: controller.signal },
      )
        .then((value) => {
          if (!cancelled) setResult({ key, ...value });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setResult({
              key,
              files: [],
              truncated: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Не удалось найти файлы",
            });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, open, full, retry]);
  useEffect(() => {
    if (open && options.length)
      document
        .getElementById(`${listId}-${active}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, options.length, listId]);

  const readCaret = (field: HTMLTextAreaElement) =>
    setCaret({ start: field.selectionStart, end: field.selectionEnd });
  const choose = (option: (typeof options)[number]) => {
    if (!mention) return;
    if (option.path) {
      if (full || filePaths.includes(option.path)) return;
      onFilesChange?.([...filePaths, option.path]);
      if (option.tab) onEditorTargetChange?.(option.tab);
    } else if (option.tab) onEditorTargetChange?.(option.tab);
    restoreCaret.current = mention.start;
    setDismissed(key);
    onDraftChange(draft.slice(0, mention.start) + draft.slice(mention.end));
  };
  return (
    <>
      {open && (
        <div className="agent-file-picker">
          <div className="agent-file-picker-heading">
            <span>Добавить в контекст</span>
            <kbd>esc</kbd>
          </div>
          {options.length > 0 && (
            <div
              id={listId}
              role="listbox"
              aria-label="Вкладки и файлы проекта"
              className="agent-file-options"
            >
              {options.map((option, index) => (
                <div
                  key={
                    option.tab ? `tab:${option.tab.id}` : `file:${option.path}`
                  }
                  role="presentation"
                >
                  {(index === 0 || index === matchingTabs.length) && (
                    <div className="agent-mention-section" role="presentation">
                      {option.tab ? "Открытые вкладки" : "Файлы проекта"}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={`${listId}-${index}`}
                    aria-selected={index === active}
                    title={option.path || option.tab?.name}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => choose(option)}
                  >
                    {option.tab && !option.path ? (
                      <Code size={16} />
                    ) : (
                      <FileText size={16} />
                    )}
                    <span>{option.tab?.name || option.path}</span>
                    {option.tab && (
                      <small>
                        {option.path ||
                          `SQL · вкладка ${editorTabs.indexOf(option.tab) + 1}`}
                      </small>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
          {full ? (
            <p role="status">Можно указать до 20 файлов</p>
          ) : !current ? (
            <p role="status">Ищем файлы…</p>
          ) : current.error ? (
            <div className="agent-file-picker-error" role="status">
              <span>{current.error}</span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setRetry((n) => n + 1)}
              >
                Повторить
              </button>
            </div>
          ) : !options.length ? (
            <p role="status">Файлы не найдены</p>
          ) : null}
          {current?.truncated && (
            <p className="agent-file-picker-hint">
              Уточните путь, чтобы найти другие файлы
            </p>
          )}
        </div>
      )}
      <label className="sr-only" htmlFor="agent-message">
        Сообщение агенту
      </label>
      <textarea
        ref={textarea}
        id="agent-message"
        rows={2}
        value={draft}
        placeholder="Что нужно сделать?"
        aria-autocomplete="list"
        aria-controls={open && options.length ? listId : undefined}
        aria-activedescendant={
          open && options.length ? `${listId}-${active}` : undefined
        }
        onFocus={(e) => {
          setFocused(true);
          readCaret(e.currentTarget);
        }}
        onBlur={() => setFocused(false)}
        onSelect={(e) => readCaret(e.currentTarget)}
        onChange={(e) => {
          setDismissed("");
          readCaret(e.currentTarget);
          onDraftChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) {
            if (e.key === "Escape") e.stopPropagation();
            return;
          }
          if (open && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDismissed(key);
            return;
          }
          if (open && !e.metaKey && !e.ctrlKey && !e.altKey) {
            if (
              options.length &&
              (e.key === "ArrowDown" || e.key === "ArrowUp")
            ) {
              e.preventDefault();
              setSelected(
                (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                  options.length,
              );
              return;
            }
            if (
              options.length &&
              (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey))
            ) {
              e.preventDefault();
              choose(options[active]);
              return;
            }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </>
  );
}

export function AgentContextChips({
  filePaths,
  onFilesChange,
  editorTarget,
  onEditorTargetChange,
  boardNodes,
  onDismissBoardNode,
}: {
  filePaths: string[];
  onFilesChange?: (paths: string[]) => void;
  editorTarget?: OpenEditorTab;
  onEditorTargetChange?: (tab: OpenEditorTab | undefined) => void;
  boardNodes: { id: string; title: string }[];
  onDismissBoardNode?: (id: string) => void;
}) {
  if (!filePaths.length && !boardNodes.length && !editorTarget) return null;
  return (
    <div className="agent-context-chips" aria-label="Контекст сообщения">
      {editorTarget && !editorTarget.path && (
        <span
          className="agent-context-chip"
          title={`Запрос для редактирования: ${editorTarget.name}`}
        >
          <Code size={14} />
          <span>{editorTarget.name}</span>
          {onEditorTargetChange && (
            <button
              type="button"
              aria-label={`Убрать запрос ${editorTarget.name}`}
              onClick={() => {
                onEditorTargetChange(undefined);
                document.getElementById("agent-message")?.focus();
              }}
            >
              <X size={12} />
            </button>
          )}
        </span>
      )}
      {boardNodes.map((node) => (
        <span
          className="agent-context-chip"
          key={`board:${node.id}`}
          title={node.title}
        >
          <ChartLine size={14} />
          <span>{node.title}</span>
          {onDismissBoardNode && (
            <button
              type="button"
              aria-label={`Убрать из контекста ${node.title}`}
              onClick={() => {
                onDismissBoardNode(node.id);
                document.getElementById("agent-message")?.focus();
              }}
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      {filePaths.map((path) => (
        <span className="agent-context-chip" key={`file:${path}`} title={path}>
          <FileText size={14} />
          <span>{path}</span>
          {onFilesChange && (
            <button
              type="button"
              aria-label={`Убрать файл ${path}`}
              onClick={() => {
                onFilesChange(filePaths.filter((value) => value !== path));
                document.getElementById("agent-message")?.focus();
              }}
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
