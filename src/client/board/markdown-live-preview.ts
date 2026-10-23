import { EditorState, Text, type ChangeSpec } from "@codemirror/state";
import { parser, GFM } from "@lezer/markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import { defaultUrlTransform } from "react-markdown";

export const MAX_MARKDOWN_LENGTH = 200000;
export const markdownParser = parser.configure(GFM);
export type PreviewPart = {
  kind:
    "hide" | "mark" | "line" | "marker" | "link" | "table" | "rule" | "image";
  from: number;
  to: number;
  className?: string;
  text?: string;
  href?: string;
};

/** A range ending exactly at the next line's start doesn't select that line. */
export function activeSourceLines(
  state: EditorState,
  focused: boolean,
): Set<number> {
  const lines = new Set<number>();
  if (focused && !state.readOnly) {
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(
        range.empty ? range.to : Math.max(range.from, range.to - 1),
      ).number;
      for (let line = first; line <= last; line++) lines.add(line);
    }
  }
  return lines;
}

/** All ranges refer to the original document, including its Markdown punctuation. */
export function planMarkdownPreview(
  source: string,
  active: Set<number>,
  tree: Tree = markdownParser.parse(source),
): PreviewPart[] {
  const doc = Text.of(source.split("\n"));
  const parts: PreviewPart[] = [];
  const references = new Map<string, string>();
  const referenceKey = (label: string) =>
    label
      .replace(/^\[|\]$/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  tree.iterate({
    enter(node) {
      if (node.name !== "LinkReference") return;
      const label = node.node.getChild("LinkLabel"),
        url = node.node.getChild("URL");
      if (label && url)
        references.set(
          referenceKey(source.slice(label.from, label.to)),
          source.slice(url.from, url.to),
        );
    },
  });
  const activeNode = (node: SyntaxNode) => {
    const first = doc.lineAt(node.from).number;
    const last = doc.lineAt(Math.max(node.from, node.to - 1)).number;
    for (let n = first; n <= last; n++) if (active.has(n)) return true;
    return false;
  };
  const line = (position: number, className: string) =>
    parts.push({
      kind: "line",
      from: doc.lineAt(position).from,
      to: doc.lineAt(position).from,
      className,
    });
  const hide = (from: number, to: number) => {
    if (to > from) parts.push({ kind: "hide", from, to });
  };
  const visit = (node: SyntaxNode) => {
    const name = node.name;
    if (name === "LinkReference" && !activeNode(node)) {
      hide(node.from, node.to);
      for (
        let n = doc.lineAt(node.from).number;
        n <= doc.lineAt(node.to).number;
        n++
      )
        line(doc.line(n).from, "md-preview-definition");
      return;
    }
    if (name === "FencedCode" || name === "CodeBlock" || name === "Table") {
      if (activeNode(node)) return;
      if (name === "Table") {
        parts.push({ kind: "table", from: node.from, to: node.to });
      } else {
        const start = doc.lineAt(node.from).number;
        const end = doc.lineAt(node.to).number;
        for (let n = start; n <= end; n++)
          line(doc.line(n).from, "md-preview-code-line");
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === "CodeMark" || child.name === "CodeInfo")
            hide(child.from, child.to);
        }
        if (name === "FencedCode") {
          // Keep small, clickable fence rows so their source remains reachable.
          line(node.from, "md-preview-code-edge");
          const last = node.lastChild;
          if (last?.name === "CodeMark")
            line(last.from, "md-preview-code-edge");
        }
      }
      return;
    }
    const isActive = activeNode(node);
    if (/^(ATX|Setext)Heading[1-6]$/.test(name)) {
      line(node.from, `md-preview-h${name.at(-1)}`);
    } else if (!isActive && name === "HeaderMark") {
      const headingLine = doc.lineAt(node.from);
      let to = node.to;
      while (to < headingLine.to && /[ \t]/.test(source[to])) to++;
      hide(node.from, to);
      if (node.parent?.name.startsWith("Setext"))
        line(node.from, "md-preview-hidden-line");
    } else if (
      !isActive &&
      ["StrongEmphasis", "Emphasis", "InlineCode", "Strikethrough"].includes(
        name,
      )
    ) {
      const className = {
        StrongEmphasis: "md-preview-strong",
        Emphasis: "md-preview-em",
        InlineCode: "md-preview-inline-code",
        Strikethrough: "md-preview-strike",
      }[name];
      parts.push({ kind: "mark", from: node.from, to: node.to, className });
    } else if (
      !isActive &&
      ["EmphasisMark", "CodeMark", "StrikethroughMark"].includes(name)
    ) {
      hide(node.from, node.to);
    } else if (!isActive && name === "ListMark") {
      if (/[-+*]/.test(source.slice(node.from, node.to)))
        parts.push({
          kind: "marker",
          from: node.from,
          to: node.to,
          text: "•",
          className: "md-preview-bullet",
        });
      line(node.from, "md-preview-list-line");
    } else if (!isActive && name === "TaskMarker") {
      parts.push({
        kind: "marker",
        from: node.from,
        to: node.to,
        text: /x/i.test(source.slice(node.from, node.to)) ? "☑" : "☐",
        className: "md-preview-task",
      });
    } else if (!isActive && name === "QuoteMark") {
      hide(node.from, node.to);
      line(node.from, "md-preview-quote-line");
    } else if (!isActive && name === "HorizontalRule") {
      parts.push({ kind: "rule", from: node.from, to: node.to });
      return;
    } else if (!isActive && name === "URL") {
      const raw = source.slice(node.from, node.to);
      parts.push({
        kind: "link",
        from: node.from,
        to: node.to,
        href:
          defaultUrlTransform(
            raw.startsWith("www.") ? "https://" + raw : raw,
          ) || undefined,
      });
      return;
    } else if (
      !isActive &&
      (name === "Link" || name === "Autolink" || name === "Image")
    ) {
      const url = node.getChild("URL");
      const label = node.getChild("LinkLabel");
      const rawURL = url
        ? source.slice(url.from, url.to)
        : references.get(
            referenceKey(
              label
                ? source.slice(label.from, label.to)
                : source.slice(node.from, node.to),
            ),
          );
      if (rawURL !== undefined) {
        if (name === "Image") {
          const end = source.indexOf("]", node.from + 2);
          parts.push({
            kind: "image",
            from: node.from,
            to: node.to,
            href: defaultUrlTransform(rawURL) || undefined,
            text: source.slice(node.from + 2, end),
          });
          return;
        }
        parts.push({
          kind: "link",
          from: node.from,
          to: node.to,
          href: defaultUrlTransform(rawURL) || undefined,
        });
        // Link punctuation and destinations are presentation only. The document stays intact.
        let labelEnd = node.from;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === "LinkMark") {
            if (child.from === node.from) hide(child.from, child.to);
            else {
              labelEnd = child.from;
              break;
            }
          }
        }
        if (labelEnd) hide(labelEnd, node.to);
        for (
          let child = node.firstChild;
          child && child.from < labelEnd;
          child = child.nextSibling
        ) {
          if (child.name !== "LinkMark") visit(child);
        }
        return;
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling)
      visit(child);
  };
  visit(tree.topNode);
  return parts.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** External board undo maps existing editor selection/history through the smallest splice. */
export function externalDocumentChange(
  before: string,
  after: string,
): ChangeSpec {
  let from = 0;
  while (
    from < before.length &&
    from < after.length &&
    before[from] === after[from]
  )
    from++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (
    oldEnd > from &&
    newEnd > from &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}

export const limitMarkdownLength = EditorState.transactionFilter.of(
  (transaction) =>
    transaction.docChanged && transaction.newDoc.length > MAX_MARKDOWN_LENGTH
      ? []
      : transaction,
);
