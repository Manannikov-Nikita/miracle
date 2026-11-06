// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectTextEditor from "../src/client/components/ProjectTextEditor";
import type { ProjectFileDraft } from "../src/client/project-file-drafts";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";

// CodeMirror is real; only Monaco's browser workers are replaced here.
vi.mock("@monaco-editor/react", () => ({
  default: (props: {
    value: string;
    language: string;
    onChange: (value: string) => void;
    options: { ariaLabel: string };
  }) =>
    createElement("textarea", {
      "aria-label": props.options.ariaLabel,
      "data-monaco-language": props.language,
      value: props.value,
      onChange: (event: { target: { value: string } }) =>
        props.onChange(event.target.value),
    }),
}));
vi.mock("monaco-editor/editor/editor.api.js", () => ({}));
vi.mock("../src/client/file-highlighting", () => ({
  ensureFileLanguage: async () => {},
}));

function file(path: string, content: string): ProjectFileDraft {
  return {
    id: path,
    path,
    name: path.split("/").at(-1)!,
    content,
    savedContent: content,
    revision: "disk-v1",
    size: content.length,
    updatedAt: "2026-11-04T00:00:00Z",
  };
}

describe("Markdown project files", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ProjectTextEditor>;
  const changes = vi.fn();
  const saves = vi.fn();
  let project: ProjectSync;
  async function render(change: Partial<typeof props> = {}) {
    props = { ...props, ...change };
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(ProjectTextEditor, props),
        ),
      ),
    );
  }
  function view() {
    return EditorView.findFromDOM(
      container.querySelector<HTMLElement>(".cm-editor")!,
    )!;
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.clearAllMocks();
    project = new ProjectSync();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      workspaceId: "markdown-test",
      file: file("docs/readme.md", "# Heading\n\n**bold** and *soft*\n"),
      saving: false,
      onSave: saves,
      onChange(value) {
        changes(value);
        props = { ...props, file: { ...props.file, content: value } };
        root.render(
          createElement(
            ProjectSyncContext.Provider,
            { value: project },
            createElement(ProjectTextEditor, props),
          ),
        );
      },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens Markdown as the board's live preview while preserving exact source", async () => {
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".md-preview-h1")?.textContent).toBe(
      "Heading",
    );
    expect(container.querySelector(".md-preview-strong")?.textContent).toBe(
      "bold",
    );
    expect(view().state.doc.toString()).toBe(props.file.content);
    expect(view().contentDOM.getAttribute("aria-label")).toBe(
      "Редактор файла docs/readme.md",
    );
    expect(changes).not.toHaveBeenCalled();
  });
  it("retains a Markdown draft while the agent locks its file and restores editing on release", async () => {
    await render();
    await act(async () =>
      view().dispatch({ changes: { from: 2, to: 9, insert: "My draft" } }),
    );
    const draft = view().state.doc.toString();
    await act(async () =>
      project.receiveWorkSnapshot({
        revision: 1,
        locks: [
          {
            target: { kind: "file", id: props.file.path },
            turnId: "turn",
            chatId: "chat",
            startedAt: "now",
          },
        ],
      }),
    );
    expect(view().contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(container.querySelector(".agent-work-indicator")?.textContent).toBe(
      "Агент работает",
    );
    expect(view().state.doc.toString()).toBe(draft);
    await act(async () =>
      view().contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          code: "KeyS",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(saves).not.toHaveBeenCalled();
    await act(async () =>
      project.receiveWorkSnapshot({ revision: 2, locks: [] }),
    );
    expect(view().contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(view().state.doc.toString()).toBe(draft);
  });

  it("edits the Markdown source and saves the current draft with Ctrl+S", async () => {
    await render();
    await act(async () =>
      view().dispatch({
        changes: { from: 2, to: 9, insert: "Updated title" },
        selection: { anchor: 15 },
      }),
    );
    expect(props.file.content).toBe("# Updated title\n\n**bold** and *soft*\n");
    expect(container.querySelector(".editor-status")?.textContent).toContain(
      "Есть изменения",
    );
    expect(container.querySelector(".editor-status")?.textContent).toContain(
      "стлб 16",
    );
    const saveLatest = vi.fn(() => props.file.content);
    await render({ onSave: saveLatest });
    const event = new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      view().contentDOM.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(saveLatest).toHaveReturnedWith(props.file.content);
    expect(saves).not.toHaveBeenCalled();
  });

  it("does not carry undo history between Markdown files and keeps JSON in Monaco", async () => {
    await render();
    await act(async () =>
      view().dispatch({ changes: { from: 2, to: 9, insert: "Local draft" } }),
    );
    const firstDraft = props.file;
    await render({ file: file("docs/second.MD", "# Second document\n") });
    expect(view().state.doc.toString()).toBe("# Second document\n");
    let undone = true;
    await act(async () => {
      undone = undo(view());
    });
    expect(undone).toBe(false);
    expect(view().state.doc.toString()).toBe("# Second document\n");
    await render({ file: firstDraft });
    expect(view().state.doc.toString()).toContain("Local draft");
    await render({ file: file("settings.json", '{"enabled":true}') });
    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe('{"enabled":true}');
    expect(container.querySelector("textarea")?.dataset.monacoLanguage).toBe(
      "json",
    );
    await render({ file: file("guide.markdown", "# Guide\n") });
    expect(container.querySelector(".md-preview-h1")?.textContent).toBe(
      "Guide",
    );
  });

  it("allows edits beyond the board card's 200k limit without truncating the file", async () => {
    const content = "plain text\n".repeat(19000);
    await render({ file: file("large.md", content) });
    await act(async () =>
      view().dispatch({
        changes: { from: content.length, insert: "last line" },
      }),
    );
    expect(props.file.content).toBe(content + "last line");
    expect(changes).toHaveBeenLastCalledWith(content + "last line");
  });
});
