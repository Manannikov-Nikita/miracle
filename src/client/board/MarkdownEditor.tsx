import { useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import type { Tree } from "@lezer/common";
import {
  activeSourceLines,
  externalDocumentChange,
  limitMarkdownLength,
  markdownParser,
  planMarkdownPreview,
  type PreviewPart,
} from "./markdown-live-preview";
import "./markdown-editor.css";

const focusPreview = StateEffect.define<boolean>();
const externalUpdate = Annotation.define<boolean>();

/** Widgets only replace syntax; their source ranges always remain in the CM document. */
class MarkerWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
    readonly from: number,
  ) {
    super();
  }
  eq(other: MarkerWidget) {
    return (
      this.text === other.text &&
      this.className === other.className &&
      this.from === other.from
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = this.className;
    dom.textContent = this.text;
    dom.addEventListener("mousedown", (event) => {
      if (view.state.readOnly) return;
      event.preventDefault();
      view.dispatch({
        selection: { anchor: this.from },
        effects: focusPreview.of(true),
      });
      view.focus();
    });
    return dom;
  }
  ignoreEvent() {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly source: string | undefined,
    readonly alt: string,
    readonly from: number,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      this.source === other.source &&
      this.alt === other.alt &&
      this.from === other.from
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "md-preview-image";
    if (this.source) {
      const image = document.createElement("img");
      image.alt = this.alt;
      image.src = this.source;
      image.addEventListener("load", () => {
        if (view.dom.isConnected) view.requestMeasure();
      });
      dom.append(image);
    } else dom.textContent = this.alt;
    dom.addEventListener("mousedown", (event) => {
      if (view.state.readOnly) return;
      event.preventDefault();
      view.dispatch({
        selection: { anchor: this.from },
        effects: focusPreview.of(true),
      });
      view.focus();
    });
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}

const tableRoots = new WeakMap<HTMLElement, Root>();
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return this.source === other.source && this.from === other.from;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "md-preview-table";
    dom.addEventListener("mousedown", (event) => {
      if (view.state.readOnly || event.button !== 0) return;
      event.preventDefault();
      const cell = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-md-from]",
      );
      const position = cell ? Number(cell.dataset.mdFrom) : this.from;
      view.dispatch({
        selection: { anchor: position },
        effects: focusPreview.of(true),
        scrollIntoView: true,
      });
      view.focus();
    });
    const root = createRoot(dom);
    tableRoots.set(dom, root);
    const from = this.from;
    root.render(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          th: ({ node, ...props }) => (
            <th
              {...props}
              data-md-from={from + (node?.position?.start.offset ?? 0)}
            />
          ),
          td: ({ node, ...props }) => (
            <td
              {...props}
              data-md-from={from + (node?.position?.start.offset ?? 0)}
            />
          ),
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {this.source}
      </ReactMarkdown>,
    );
    // React mounts asynchronously; let CM measure the completed table height.
    requestAnimationFrame(() => {
      if (view.dom.isConnected) view.requestMeasure();
    });
    return dom;
  }
  destroy(dom: HTMLElement) {
    const root = tableRoots.get(dom);
    tableRoots.delete(dom);
    // Widget destruction can occur during a parent React commit.
    if (root) queueMicrotask(() => root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

function decorationsFor(
  state: EditorState,
  focused: boolean,
  tree: Tree,
): DecorationSet {
  const source = state.doc.toString();
  const ranges = planMarkdownPreview(
    source,
    activeSourceLines(state, focused),
    tree,
  ).map((part: PreviewPart) => {
    if (part.kind === "line")
      return Decoration.line({ class: part.className }).range(part.from);
    if (part.kind === "hide")
      return Decoration.replace({}).range(part.from, part.to);
    if (part.kind === "image")
      return Decoration.replace({
        widget: new ImageWidget(part.href, part.text ?? "", part.from),
      }).range(part.from, part.to);
    if (part.kind === "table")
      return Decoration.replace({
        block: true,
        widget: new TableWidget(source.slice(part.from, part.to), part.from),
      }).range(part.from, part.to);
    if (part.kind === "marker" || part.kind === "rule")
      return Decoration.replace({
        widget: new MarkerWidget(
          part.text ?? "",
          part.className ?? "md-preview-rule",
          part.from,
        ),
      }).range(part.from, part.to);
    if (part.kind === "link")
      return Decoration.mark({
        tagName: part.href ? "a" : "span",
        class: "md-preview-link",
        attributes: part.href
          ? { href: part.href, target: "_blank", rel: "noopener noreferrer" }
          : {},
      }).range(part.from, part.to);
    return Decoration.mark({ class: part.className }).range(part.from, part.to);
  });
  return Decoration.set(ranges, true);
}

const previewField = StateField.define<{
  tree: Tree;
  focused: boolean;
  decorations: DecorationSet;
}>({
  create(state) {
    const tree = markdownParser.parse(state.doc.toString());
    return {
      tree,
      focused: false,
      decorations: decorationsFor(state, false, tree),
    };
  },
  update(previous, transaction) {
    let focused = previous.focused;
    for (const effect of transaction.effects)
      if (effect.is(focusPreview)) focused = effect.value;
    if (
      !transaction.docChanged &&
      !transaction.selection &&
      focused === previous.focused &&
      !transaction.reconfigured
    )
      return previous;
    const tree = transaction.docChanged
      ? markdownParser.parse(transaction.newDoc.toString())
      : previous.tree;
    return {
      tree,
      focused,
      decorations: decorationsFor(transaction.state, focused, tree),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

export type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
};

export default function MarkdownEditor({
  value,
  onChange,
  readOnly,
}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyCompartment = useRef(new Compartment());
  onChangeRef.current = onChange;
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorState.lineSeparator.of("\n"),
          readOnlyCompartment.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorState.allowMultipleSelections.of(true),
          markdown({ extensions: GFM }),
          history(),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          limitMarkdownLength,
          previewField,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "Текст Markdown",
            role: "textbox",
            "aria-multiline": "true",
            spellcheck: "true",
          }),
          EditorView.domEventHandlers({
            focus: (_event, editor) => {
              // CM computes the clicked selection during mousedown. Revealing the old
              // cursor line synchronously would change layout before that computation.
              queueMicrotask(() => {
                if (editor.hasFocus && editor.dom.isConnected)
                  editor.dispatch({ effects: focusPreview.of(true) });
              });
            },
            blur: (_event, editor) => {
              editor.dispatch({ effects: focusPreview.of(false) });
            },
            click: (event, editor) => {
              if (
                !editor.state.readOnly &&
                (event.target as HTMLElement).closest("a")
              )
                event.preventDefault();
            },
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.every((transaction) =>
                transaction.annotation(externalUpdate),
              )
            )
              onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // A mounted card owns one editor. Current callbacks and external values are synced separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const changes =
      view.state.doc.toString() !== value
        ? externalDocumentChange(view.state.doc.toString(), value)
        : undefined;
    const effects =
      view.state.readOnly !== readOnly
        ? [
            readOnlyCompartment.current.reconfigure([
              EditorState.readOnly.of(readOnly),
              EditorView.editable.of(!readOnly),
            ]),
          ]
        : [];
    if (changes || effects.length)
      view.dispatch({
        changes,
        effects,
        annotations: [
          externalUpdate.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
  }, [value, readOnly]);

  return (
    <div
      ref={host}
      className={`board-markdown-editor nodrag nopan nowheel nokey${readOnly ? " is-readonly" : ""}`}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onKeyPress={(event) => event.stopPropagation()}
    />
  );
}
