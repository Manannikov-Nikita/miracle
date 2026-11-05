import katex, { type KatexOptions } from "katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type PluggableList, type Plugin } from "unified";
import { visit, SKIP } from "unist-util-visit";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import type { Root as MarkdownRoot } from "mdast";
import type { Root as HtmlRoot } from "hast";

const mathOptions: KatexOptions = {
  trust: false,
  throwOnError: false,
  strict: "ignore",
  maxExpand: 1000,
  maxSize: 20,
  output: "htmlAndMathml",
};

/** Only KaTeX's generated, untrusted-input-safe HTML may enter a math widget. */
export function renderMath(source: string, display: boolean): string {
  try {
    return katex.renderToString(source, {
      ...mathOptions,
      displayMode: display,
    });
  } catch {
    const escaped = source.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
    return `<span class="katex-error">${escaped}</span>`;
  }
}

// Treat paired double dollars as display math even when written on one line.
const remarkDisplayMath: Plugin<[], MarkdownRoot> = () => (tree, file) => {
  const source = String(file);
  visit(tree, "inlineMath", (node) => {
    const from = node.position?.start.offset;
    if (from !== undefined && source.slice(from, from + 2) === "$$") {
      node.data = {
        ...node.data,
        hProperties: { className: ["math-display"] },
      };
    }
  });
};

/** Render only remark-math nodes; fenced `math` code remains ordinary code. */
const rehypeMath: Plugin<[], HtmlRoot> = () => (tree) => {
  visit(tree, "element", (node, index, parent) => {
    const classes = node.properties.className;
    if (!Array.isArray(classes) || !parent || index === undefined) return;
    const display = classes.includes("math-display");
    if (!display && !classes.includes("math-inline")) return;
    const source = node.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("");
    const rendered = fromHtmlIsomorphic(renderMath(source, display), {
      fragment: true,
    });
    // remark-math's block is <pre><code>; remove the code wrapper, too.
    node.tagName = "span";
    node.properties = {};
    node.children = rendered.children.filter(
      (child) => child.type !== "doctype",
    );
    if (parent.type === "element" && parent.tagName === "pre")
      parent.tagName = "div";
    return SKIP;
  });
};

export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkMath,
  remarkDisplayMath,
];
export const markdownRehypePlugins: PluggableList = [rehypeMath];

const mathParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export type MarkdownMathRange = {
  from: number;
  to: number;
  text: string;
  display: boolean;
};

/** Use the same Markdown grammar as rendered views, preserving exact offsets. */
export function markdownMathRanges(source: string): MarkdownMathRange[] {
  if (!source.includes("$")) return [];
  const ranges: MarkdownMathRange[] = [];
  visit(mathParser.parse(source), (node) => {
    // Tables are a single live-preview widget and render their own formulas.
    if (node.type === "table") return SKIP;
    if (node.type !== "math" && node.type !== "inlineMath") return;
    const from = node.position?.start.offset,
      to = node.position?.end.offset;
    if (from === undefined || to === undefined) return;
    ranges.push({
      from,
      to,
      text: node.value,
      display: source.slice(from, from + 2) === "$$",
    });
  });
  return ranges;
}
