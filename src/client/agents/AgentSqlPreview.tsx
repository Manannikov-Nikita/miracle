import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowSquareOut, CircleNotch } from "@phosphor-icons/react";
import { compile } from "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
import { MonarchTokenizer } from "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
import { clickhouseSqlLanguage } from "../sql-highlighting";
import "./agent-sql-preview.css";

// Use the editor's shared SQL lexer without creating an editor, worker or theme
// service. Plain lexical tokens do not need embedded-language or theme services.
const previewLanguageId = "miracle-agent-sql-preview";
const previewLexer = compile(previewLanguageId, clickhouseSqlLanguage);
const coloredTokens = new Set([
  "keyword",
  "string",
  "number",
  "comment",
  "operator",
]);

function highlightedSql(sql: string) {
  // Keep the original line endings, while carrying SQL lexer state across lines.
  const lines = sql.split(/(\r\n|\r|\n)/);
  const tokenizer = new MonarchTokenizer(
    {},
    {},
    previewLanguageId,
    previewLexer,
    {
      getValue: () => 20000,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  );
  try {
    let state = tokenizer.getInitialState();
    return lines.flatMap<ReactNode>((line, lineIndex) => {
      if (lineIndex % 2) return line;
      const result = tokenizer.tokenize(line, true, state);
      state = result.endState;
      return result.tokens.map((token, index) => {
        const kind = token.type.split(".")[0];
        return (
          <span
            key={`${lineIndex}:${token.offset}`}
            className={
              coloredTokens.has(kind) ? `agent-sql-token-${kind}` : undefined
            }
          >
            {line.slice(
              token.offset,
              result.tokens[index + 1]?.offset ?? line.length,
            )}
          </span>
        );
      });
    });
  } finally {
    tokenizer.dispose();
  }
}

export default function AgentSqlPreview({
  sql,
  onOpen,
  onOpened,
}: {
  sql: string;
  onOpen?: () => Promise<void>;
  onOpened?: () => void;
}) {
  const content = useMemo(() => highlightedSql(sql), [sql]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const open = async () => {
    if (!onOpen || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await onOpen();
      if (mounted.current) onOpened?.();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось открыть запрос в редакторе",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="agent-sql-preview">
      {onOpen && (
        <div className="agent-sql-preview-toolbar">
          <button
            type="button"
            className="agent-icon-button agent-sql-preview-open"
            title="Открыть в редакторе"
            aria-label="Открыть в редакторе"
            aria-busy={busy}
            disabled={busy}
            onClick={() => void open()}
          >
            {busy ? (
              <CircleNotch
                size={16}
                className="agent-sql-preview-spinner"
                aria-hidden="true"
              />
            ) : (
              <ArrowSquareOut size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      )}
      <pre>
        <code>{content}</code>
      </pre>
      {error && (
        <p className="agent-sql-preview-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
