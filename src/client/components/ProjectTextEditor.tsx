import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { FloppyDisk } from "@phosphor-icons/react";
import { ensureFileLanguage } from "../file-highlighting";
import {
  editorModelPath,
  fileLanguage,
  type ProjectFileDraft,
} from "../project-file-drafts";
import { IconButton, Spinner } from "./UI";
import MarkdownEditor, {
  type MarkdownEditorSnapshot,
} from "../board/MarkdownEditor";
import { MAX_PROJECT_FILE_BYTES } from "../../shared/project-files";
import "./project-text-editor.css";
import {
  currentAgentWork,
  findAgentWork,
  useAgentWork,
} from "../agents/useAgentWork";
import { useProjectSync } from "../agents/ProjectSync";
import { AgentWorkIndicator } from "../agents/AgentWorkIndicator";
import {
  resolveSearchMatch,
  type TextSearchRevealRequest,
} from "../../shared/workspace-search";

export default function ProjectTextEditor({
  workspaceId,
  file,
  saving,
  readOnly = false,
  onChange,
  onSave,
  revealRequest,
  onRevealComplete,
  markdownSnapshots,
}: {
  workspaceId: string;
  file: ProjectFileDraft;
  saving: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  revealRequest?: TextSearchRevealRequest;
  onRevealComplete?: (requestId: string, found: boolean) => void;
  markdownSnapshots?: Map<string, MarkdownEditorSnapshot>;
}) {
  const project = useProjectSync();
  const work = useAgentWork(
    file.deleted ? null : { kind: "file", id: file.path },
  );
  const applyingDraft = useRef(false);
  const locked = () =>
    readOnly ||
    Boolean(
      !file.deleted &&
      findAgentWork(currentAgentWork(project), { kind: "file", id: file.path }),
    );
  const change = (value: string) => {
    if (!applyingDraft.current && !locked()) onChange(value);
  };
  const saveFile = () => {
    if (!file.deleted && !locked()) onSave();
  };
  const save = useRef(onSave);
  save.current = saveFile;
  const language = fileLanguage(file.path);
  const isMarkdown = language === "markdown";
  const [ready, setReady] = useState(false);
  const modelLanguage = ready ? language : "plaintext";
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const syncModel = useRef<
    (editor: monaco.editor.IStandaloneCodeEditor) => void
  >(() => {});
  syncModel.current = (editor) => {
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelLanguage(model, modelLanguage);
    if (model.getValue() === file.content) return;
    applyingDraft.current = true;
    try {
      model.pushStackElement();
      model.pushEditOperations(
        null,
        [{ range: model.getFullModelRange(), text: file.content }],
        () => null,
      );
      model.pushStackElement();
    } finally {
      applyingDraft.current = false;
    }
  };
  const revealedRequest = useRef<string | null>(null);
  useEffect(() => {
    const model = editor?.getModel();
    if (
      isMarkdown ||
      !editor ||
      !model ||
      !revealRequest ||
      revealedRequest.current === revealRequest.requestId ||
      model.uri.toString() !==
        monaco.Uri.parse(editorModelPath(workspaceId, file.id)).toString()
    )
      return;
    revealedRequest.current = revealRequest.requestId;
    const match = revealRequest.match;
    const range = match
      ? resolveSearchMatch(model.getValue(), match)
      : undefined;
    if (range) {
      const start = model.getPositionAt(range.start),
        end = model.getPositionAt(range.end);
      const selection = new monaco.Range(
        start.lineNumber,
        start.column,
        end.lineNumber,
        end.column,
      );
      editor.setSelection(selection);
      editor.revealRangeInCenter(selection);
    }
    editor.focus();
    onRevealComplete?.(revealRequest.requestId, !match || Boolean(range));
  }, [
    editor,
    isMarkdown,
    revealRequest,
    file.path,
    file.id,
    file.content,
    workspaceId,
    onRevealComplete,
  ]);
  useEffect(() => {
    if (!editor) return;
    const updateCursor = () =>
      setCursor(editor.getPosition() ?? { lineNumber: 1, column: 1 });
    updateCursor();
    const listeners = [
      editor.onDidChangeCursorPosition(updateCursor),
      editor.onDidChangeModel(() => {
        syncModel.current(editor);
        updateCursor();
      }),
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
        <div className="sql-toolbar-context">
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
        </div>
        <AgentWorkIndicator work={work} />
        <IconButton
          label="Сохранить файл (⌘S / Ctrl+S)"
          disabled={file.deleted || saving || Boolean(work)}
          onClick={saveFile}
        >
          {saving ? <Spinner /> : <FloppyDisk size={16} />}
        </IconButton>
      </div>
      <div
        className={`editor-area project-text-editor${work ? " agent-work-active" : ""}`}
      >
        {isMarkdown ? (
          <div className="project-markdown-file">
            <MarkdownEditor
              key={`${workspaceId}:${file.id}`}
              value={file.content}
              onChange={change}
              readOnly={readOnly || Boolean(work)}
              ariaLabel={`Редактор файла ${file.path}`}
              onSave={saveFile}
              onCursorChange={setCursor}
              maxLength={MAX_PROJECT_FILE_BYTES}
              revealRequest={revealRequest}
              onRevealComplete={onRevealComplete}
              initialSnapshot={markdownSnapshots?.get(file.id)}
              onSnapshot={
                markdownSnapshots
                  ? (snapshot) => markdownSnapshots.set(file.id, snapshot)
                  : undefined
              }
            />
          </div>
        ) : (
          <Editor
            path={editorModelPath(workspaceId, file.id)}
            value={file.content}
            language={modelLanguage}
            theme="miracle-dark"
            onChange={(value) => change(value ?? "")}
            saveViewState
            keepCurrentModel
            onMount={(editor) => {
              syncModel.current(editor);
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
              readOnly: readOnly || Boolean(work),
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
            {file.deleted
              ? "Черновик · "
              : file.content !== file.savedContent
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
