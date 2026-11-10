// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarkdownEditor, {
  type MarkdownEditorProps,
} from "../src/client/board/MarkdownEditor";
import { MAX_MARKDOWN_LENGTH } from "../src/client/board/markdown-live-preview";

describe("shared Markdown editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: MarkdownEditorProps;
  const onChange = vi.fn();

  function view() {
    const editor = EditorView.findFromDOM(
      container.querySelector(".cm-content")!,
    );
    expect(editor).toBeTruthy();
    return editor!;
  }
  async function render(change: Partial<MarkdownEditorProps> = {}) {
    props = { ...props, ...change };
    await act(async () => root.render(createElement(MarkdownEditor, props)));
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
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = { value: "# Heading\n\nBody", onChange, readOnly: false };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    vi.unstubAllGlobals();
  });

  it("renders the existing live preview while keeping exact Markdown source", async () => {
    await render();
    expect(container.querySelector(".md-preview-h1")?.textContent).toBe(
      "Heading",
    );
    expect(view().state.doc.toString()).toBe(props.value);
    expect(view().contentDOM.getAttribute("aria-label")).toBe("Текст Markdown");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows skill metadata as exact editable source without Markdown widgets", async () => {
    const metadata = "---\nname: my_skill\ndescription: **literal** $x$\n---\n";
    const source = metadata + "# Body";
    await render({ value: source });
    expect(view().state.doc.toString()).toBe(source);
    expect(view().contentDOM.textContent).toContain("name: my_skill");
    expect(view().contentDOM.textContent).toContain(
      "description: **literal** $x$",
    );
    expect(container.querySelector(".md-preview-rule, .katex")).toBeNull();
    expect(container.querySelector(".md-preview-h1")?.textContent).toBe("Body");
    await act(async () =>
      view().dispatch({ changes: { from: 10, to: 18, insert: "new_skill" } }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      source.slice(0, 10) + "new_skill" + source.slice(18),
    );
  });

  it("renders math locally and reveals editable source when a formula is clicked", async () => {
    const source = "Inline $x^2$\n\n$$\n\\frac{1}{2}\n$$";
    await render({ value: source });
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(view().state.doc.toString()).toBe(source);
    const formula = container.querySelector(".md-preview-math")!;
    await act(async () =>
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(view().state.selection.main.head).toBe(7);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(view().contentDOM.textContent).toContain("$x^2$");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps invalid formulas readable and forbids math links or embedded HTML", async () => {
    await render({
      value:
        "$\\frac{$\n\n$\\href{javascript:alert(1)}{bad}$\n\n$\\htmlClass{injected}{x}$",
    });
    expect(container.querySelector(".katex-error")).not.toBeNull();
    expect(container.querySelector("a, .injected")).toBeNull();
    expect(view().state.doc.toString()).toBe(props.value);
  });

  it("renders formulas inside table cells without replacing the table source twice", async () => {
    await render({ value: "| Formula |\n| --- |\n| $x^2$ |" });
    expect(container.querySelectorAll("table .katex")).toHaveLength(1);
    expect(view().state.doc.toString()).toBe(props.value);
    const formula = container.querySelector("table .katex")!;
    await act(async () =>
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(container.querySelector("table")).toBeNull();
    expect(view().contentDOM.textContent).toContain("$x^2$");
  });

  it("uses the file label and latest save callback without recreating the editor", async () => {
    const first = vi.fn(),
      latest = vi.fn();
    await render({ ariaLabel: "Файл README.md", onSave: first });
    const original = view();
    expect(original.contentDOM.getAttribute("aria-label")).toBe(
      "Файл README.md",
    );
    const key = new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      original.contentDOM.dispatchEvent(key);
    });
    expect(key.defaultPrevented).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    await render({ ariaLabel: "Markdown-файл README.md", onSave: latest });
    expect(view()).toBe(original);
    expect(original.contentDOM.getAttribute("aria-label")).toBe(
      "Markdown-файл README.md",
    );
    await act(async () => {
      original.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          code: "KeyS",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(first).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports cursor position on mount, selection and edits using the current callback", async () => {
    const first = vi.fn(),
      latest = vi.fn();
    await render({ onCursorChange: first });
    expect(first).toHaveBeenLastCalledWith({ lineNumber: 1, column: 1 });
    await act(async () => {
      view().dispatch({ selection: { anchor: 13 } });
    });
    expect(first).toHaveBeenLastCalledWith({ lineNumber: 3, column: 3 });
    await render({ onCursorChange: latest });
    await act(async () => {
      view().dispatch({
        changes: { from: 13, insert: "!" },
        selection: { anchor: 14 },
      });
    });
    expect(latest).toHaveBeenLastCalledWith({ lineNumber: 3, column: 4 });
    expect(onChange).toHaveBeenLastCalledWith("# Heading\n\nBo!dy");
  });

  it("allows a file above the board length limit when given a larger limit", async () => {
    const content = "x".repeat(MAX_MARKDOWN_LENGTH + 1);
    await render({ value: content, maxLength: 2 * 1024 * 1024 });
    await act(async () => {
      view().dispatch({ changes: { from: content.length, insert: "!" } });
    });
    expect(onChange).toHaveBeenLastCalledWith(content + "!");
  });

  it("retains the board default and reacts to a changed custom limit", async () => {
    await render({ value: "x".repeat(MAX_MARKDOWN_LENGTH) });
    await act(async () => {
      view().dispatch({ changes: { from: MAX_MARKDOWN_LENGTH, insert: "!" } });
    });
    expect(view().state.doc.length).toBe(MAX_MARKDOWN_LENGTH);
    expect(onChange).not.toHaveBeenCalled();
    await render({ maxLength: MAX_MARKDOWN_LENGTH + 1 });
    await act(async () => {
      view().dispatch({ changes: { from: MAX_MARKDOWN_LENGTH, insert: "!" } });
    });
    expect(view().state.doc.length).toBe(MAX_MARKDOWN_LENGTH + 1);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("preserves CRLF, trailing whitespace and BOM through edits and external refresh", async () => {
    const content = "\uFEFF# Heading\r\n\r\nBody  \r\n";
    await render({ value: content });
    expect(view().state.doc.toString()).toBe(content);
    await act(async () => {
      view().dispatch({ changes: { from: 3, insert: "New " } });
    });
    const edited = content.slice(0, 3) + "New " + content.slice(3);
    expect(onChange).toHaveBeenLastCalledWith(edited);
    onChange.mockClear();
    const remote = edited.replace("Body", "External body");
    await render({ value: remote });
    expect(view().state.doc.toString()).toBe(remote);
    expect(onChange).not.toHaveBeenCalled();
  });
});
