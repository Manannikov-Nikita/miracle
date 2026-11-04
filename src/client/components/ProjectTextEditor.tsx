import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { FloppyDisk } from "@phosphor-icons/react";
import { ensureFileLanguage } from "../file-highlighting";
import { fileLanguage, type ProjectFileDraft } from "../project-file-drafts";
import { IconButton, Spinner } from "./UI";
import MarkdownEditor from "../board/MarkdownEditor";
import { MAX_PROJECT_FILE_BYTES } from "../../shared/project-files";
import "./project-text-editor.css";

export default function ProjectTextEditor({
  workspaceId,
  file,
  saving,
  onChange,
  onSave,
}: {
  workspaceId: string;
  file: ProjectFileDraft;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const save = useRef(onSave);
  save.current = onSave;
  const language = fileLanguage(file.path);
  const isMarkdown = language === "markdown";
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  useEffect(() => {
    if (!editor) return;
    const updateCursor = () =>
      setCursor(editor.getPosition() ?? { lineNumber: 1, column: 1 });
    updateCursor();
    const listeners = [
      editor.onDidChangeCursorPosition(updateCursor),
      editor.onDidChangeModel(updateCursor),
    ];
    return () => listeners.forEach((listener) => listener.dispose());
  }, [editor]);
  useEffect(() => {
    if (isMarkdown) {
      setEditor(null);
      return;
    }
    let mounted = true;
    void ensureFileLanguage().then(() => {
      if (mounted) setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, [isMarkdown]);
  return (
    <>
      <div className="sql-toolbar">
        <span
          className="project-file-path"
          title={file.path}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {file.path}
        </span>
        <IconButton
          label="Сохранить файл (⌘S / Ctrl+S)"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? <Spinner /> : <FloppyDisk size={16} />}
        </IconButton>
      </div>
      <div className="editor-area project-text-editor">
        {isMarkdown ? (
          <div className="project-markdown-file">
            <MarkdownEditor
              key={`${workspaceId}:${file.id}`}
              value={file.content}
              onChange={onChange}
              readOnly={false}
              ariaLabel={`Редактор файла ${file.path}`}
              onSave={onSave}
              onCursorChange={setCursor}
              maxLength={MAX_PROJECT_FILE_BYTES}
            />
          </div>
        ) : (
          <Editor
            path={`miracle-file://${workspaceId}/${encodeURIComponent(file.path)}`}
            value={file.content}
            language={ready ? language : "plaintext"}
            theme="miracle-dark"
            onChange={(value) => onChange(value ?? "")}
            saveViewState
            onMount={(editor) => {
              setEditor(editor);
              editor.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                () => save.current(),
              );
            }}
            loading={
              <div className="editor-loading">
                <Spinner /> Открываем файл…
              </div>
            }
            options={{
              fontSize: 13,
              fontFamily:
                '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
              lineHeight: 23,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 18, bottom: 14 },
              tabSize: 4,
              ariaLabel: `Редактор файла ${file.path}`,
              stickyScroll: { enabled: false },
            }}
          />
        )}
        <div className="editor-status">
          <span>
            {isMarkdown
              ? "Markdown"
              : language === "plaintext"
                ? "Текст"
                : language}
          </span>
          <span>
            {file.content !== file.savedContent
              ? "Есть изменения · "
              : "Сохранён · "}
            Стр {cursor.lineNumber}, стлб {cursor.column}
            <span className="footer-divider" />
            UTF-8
          </span>
        </div>
      </div>
    </>
  );
}
