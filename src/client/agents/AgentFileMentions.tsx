import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChartLine, FileText, X } from "@phosphor-icons/react";
import { api } from "../api";

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
  onSubmit: () => void;
}
export default function AgentFileMentions({
  draft,
  draftKey,
  onDraftChange,
  filePaths,
  onFilesChange,
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
    focused && onFilesChange ? mentionAt(draft, caret.start, caret.end) : null;
  const key = mention
    ? `${draftKey}:${mention.start}:${mention.end}:${mention.query}`
    : "";
  const open = Boolean(mention && key !== dismissed);
  const full = filePaths.length >= 20;
  const current = result?.key === key ? result : null;
  const files = full
    ? []
    : current?.files.filter((path) => !filePaths.includes(path)) || [];
  const active = Math.min(selected, Math.max(0, files.length - 1));

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
    if (!open || full || !mention) return;
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
    if (open && files.length)
      document
        .getElementById(`${listId}-${active}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, files.length, listId]);

  const readCaret = (field: HTMLTextAreaElement) =>
    setCaret({ start: field.selectionStart, end: field.selectionEnd });
  const choose = (path: string) => {
    if (!mention || full || filePaths.includes(path)) return;
    restoreCaret.current = mention.start;
    setDismissed(key);
    onFilesChange?.([...filePaths, path]);
    onDraftChange(draft.slice(0, mention.start) + draft.slice(mention.end));
  };
  return (
    <>
      {open && (
        <div className="agent-file-picker">
          <div className="agent-file-picker-heading">
            <span>Файлы проекта</span>
            <kbd>esc</kbd>
          </div>
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
          ) : files.length ? (
            <>
              <div
                id={listId}
                role="listbox"
                aria-label="Файлы проекта"
                className="agent-file-options"
              >
                {files.map((path, index) => (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    key={path}
                    id={`${listId}-${index}`}
                    aria-selected={index === active}
                    title={path}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => choose(path)}
                  >
                    <FileText size={16} />
                    <span>{path}</span>
                  </button>
                ))}
              </div>
              {current.truncated && (
                <p className="agent-file-picker-hint">
                  Уточните путь, чтобы найти другие файлы
                </p>
              )}
            </>
          ) : (
            <p role="status">Файлы не найдены</p>
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
        aria-controls={open && files.length ? listId : undefined}
        aria-activedescendant={
          open && files.length ? `${listId}-${active}` : undefined
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
              files.length &&
              (e.key === "ArrowDown" || e.key === "ArrowUp")
            ) {
              e.preventDefault();
              setSelected(
                (active + (e.key === "ArrowDown" ? 1 : -1) + files.length) %
                  files.length,
              );
              return;
            }
            if (
              files.length &&
              (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey))
            ) {
              e.preventDefault();
              choose(files[active]);
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
  boardNodes,
  onDismissBoardNode,
}: {
  filePaths: string[];
  onFilesChange?: (paths: string[]) => void;
  boardNodes: { id: string; title: string }[];
  onDismissBoardNode?: (id: string) => void;
}) {
  if (!filePaths.length && !boardNodes.length) return null;
  return (
    <div className="agent-context-chips" aria-label="Контекст сообщения">
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
