import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  activeSourceLines,
  planMarkdownPreview,
  externalDocumentChange,
  limitMarkdownLength,
} from "../src/client/board/markdown-live-preview";

describe("Markdown live preview", () => {
  it("keeps YAML front matter literal while previewing the Markdown body", () => {
    const metadata =
      "---\nname: my_skill\ndescription: **literal** $value$ [link](https://example.com)\n---\n";
    const source = metadata + "# Heading\n\n**Body** $x$";
    const parts = planMarkdownPreview(source, new Set());
    expect(
      parts
        .filter((p) => p.from < metadata.length)
        .every(
          (p) => p.kind === "line" && p.className === "md-preview-frontmatter",
        ),
    ).toBe(true);
    expect(parts.find((p) => p.className === "md-preview-h1")?.from).toBe(
      metadata.length,
    );
    expect(
      parts
        .filter((p) => p.kind === "math")
        .map((p) => source.slice(p.from, p.to)),
    ).toEqual(["$x$"]);
  });

  it("preserves front matter with BOM and CRLF and keeps an unfinished mapping editable", () => {
    for (const source of [
      "\uFEFF---\r\nname: my_skill\r\ndescription: $cost$\r\n---\r\n",
      "---\nname: my_skill\ndescription: **literal** $cost$",
    ]) {
      const parts = planMarkdownPreview(source, new Set());
      expect(parts.length).toBeGreaterThan(0);
      expect(
        parts.every(
          (p) => p.kind === "line" && p.className === "md-preview-frontmatter",
        ),
      ).toBe(true);
    }
  });

  it("retains ordinary horizontal rules and does not use YAML links as body references", () => {
    expect(
      planMarkdownPreview("---\n\n# Body", new Set()).some(
        (p) => p.kind === "rule",
      ),
    ).toBe(true);
    const source = "---\nname: my_skill\n[x]: https://example.com\n---\n\n[x]";
    expect(
      planMarkdownPreview(source, new Set()).some((p) => p.kind === "link"),
    ).toBe(false);
  });

  it("previews inline and display math with original source ranges", () => {
    const source =
      "Total $x_1 + x_2$\n\n$$\\frac{1}{2}$$\n\n$$\na^2+b^2=c^2\n$$";
    const math = planMarkdownPreview(source, new Set()).filter(
      (p) => p.kind === "math",
    );
    expect(math.map((p) => source.slice(p.from, p.to))).toEqual([
      "$x_1 + x_2$",
      "$$\\frac{1}{2}$$",
      "$$\na^2+b^2=c^2\n$$",
    ]);
    expect(math.map((p) => p.display)).toEqual([false, true, true]);
    expect(
      planMarkdownPreview(source, new Set([6])).filter(
        (p) => p.kind === "math",
      ),
    ).toHaveLength(2);
    expect(planMarkdownPreview(source, new Set([1, 3, 6]))).toEqual([]);
  });

  it("does not parse math in code, escaped dollars, or link destinations", () => {
    const source =
      "`$code$` \\$escaped\\$ [link](https://x.test/$path$)\n\n```math\n$x$\n```\n\n    $indented$\n\n$real$";
    const math = planMarkdownPreview(source, new Set()).filter(
      (p) => p.kind === "math",
    );
    expect(math.map((p) => source.slice(p.from, p.to))).toEqual(["$real$"]);
  });

  it("preserves surrounding emphasis and links while leaving incomplete inline math editable", () => {
    const source =
      "**Value $x$** and [formula $y$](https://example.com)\n\n$unfinished";
    const parts = planMarkdownPreview(source, new Set());
    expect(parts.filter((p) => p.kind === "math")).toHaveLength(2);
    expect(
      parts.find((p) => p.className === "md-preview-strong"),
    ).toMatchObject({ from: 0, to: 13 });
    expect(parts.find((p) => p.kind === "link")).toMatchObject({
      href: "https://example.com",
    });
    expect(parts.some((p) => p.from >= source.indexOf("$unfinished"))).toBe(
      false,
    );
  });

  it("does not hide formula punctuation or create overlapping table widgets", () => {
    const source = "$a_1 * b_2* + `x`$\n\n| Formula |\n| --- |\n| $x$ |";
    const parts = planMarkdownPreview(source, new Set());
    expect(parts.filter((p) => p.from < 18)).toMatchObject([
      { kind: "math", from: 0, to: 18 },
    ]);
    expect(parts.filter((p) => p.kind === "math")).toHaveLength(1);
    expect(parts.filter((p) => p.kind === "table")).toHaveLength(1);
  });

  it("reveals only cursor lines and all lines covered by a selection", () => {
    const state = EditorState.create({
      doc: "# One\n\n**two**\nthree",
      selection: EditorSelection.range(8, 17),
    });
    expect([...activeSourceLines(state, true)]).toEqual([3, 4]);
    expect([...activeSourceLines(state, false)]).toEqual([]);
    const boundary = EditorState.create({
      doc: "one\ntwo\nthree",
      selection: EditorSelection.range(0, 4),
    });
    expect([...activeSourceLines(boundary, true)]).toEqual([1]);
  });

  it("hides formatting without rewriting source offsets or trimming whitespace", () => {
    const source = "# Heading\n\n  **bold** and *soft*\n";
    const plan = planMarkdownPreview(source, new Set());
    expect(
      plan
        .filter((p) => p.kind === "hide")
        .map((p) => source.slice(p.from, p.to)),
    ).toEqual(["# ", "**", "**", "*", "*"]);
    expect(
      plan.some(
        (p) =>
          p.kind === "mark" &&
          p.className === "md-preview-strong" &&
          source.slice(p.from, p.to) === "**bold**",
      ),
    ).toBe(true);
    expect(
      planMarkdownPreview(source, new Set([3])).filter((p) => p.from >= 11),
    ).toEqual([]);
  });

  it("reveals entire fenced code block while its content is being edited", () => {
    const source = "Before\n\n```js\nconst x = 1;\n```\n\nAfter";
    const inactive = planMarkdownPreview(source, new Set());
    expect(
      inactive.filter((p) => p.className === "md-preview-code-line").length,
    ).toBe(3);
    const active = planMarkdownPreview(source, new Set([4]));
    expect(active.filter((p) => p.from >= 8 && p.from < 29)).toEqual([]);
  });

  it("renders GFM tables as a widget and returns source while any table row is selected", () => {
    const source = "| Name | Value |\n| --- | --- |\n| **A** | 2 |";
    expect(
      planMarkdownPreview(source, new Set()).filter((p) => p.kind === "table"),
    ).toHaveLength(1);
    expect(planMarkdownPreview(source, new Set([3]))).toEqual([]);
  });

  it("keeps links safe while preserving their exact source", () => {
    const source = "[safe](https://example.com) [bad](javascript:alert%281%29)";
    const links = planMarkdownPreview(source, new Set()).filter(
      (p) => p.kind === "link",
    );
    expect(links.map((p) => p.href)).toEqual([
      "https://example.com",
      undefined,
    ]);
    expect(links.map((p) => source.slice(p.from, p.to))).toEqual([
      "[safe](https://example.com)",
      "[bad](javascript:alert%281%29)",
    ]);
  });

  it("renders safe image widgets and reveals their exact Markdown on the active line", () => {
    const source = "![Chart](https://example.com/chart.png)";
    expect(
      planMarkdownPreview(source, new Set()).filter((p) => p.kind === "image"),
    ).toMatchObject([
      { from: 0, to: 39, href: "https://example.com/chart.png", text: "Chart" },
    ]);
    expect(planMarkdownPreview(source, new Set([1]))).toEqual([]);
  });

  it("keeps heading geometry while revealing source after a click", () => {
    const source = "# Heading\n\nBody";
    const focused = planMarkdownPreview(source, new Set([1]));
    expect(focused.some((p) => p.className === "md-preview-h1")).toBe(true);
    expect(focused.some((p) => p.kind === "hide")).toBe(false);
  });

  it("renders nested link emphasis and bare GFM URLs while suppressing definitions", () => {
    const source =
      "[**bold**](https://x.com) https://example.com\n\n[ref][x]\n\n[x]: https://example.com";
    const plan = planMarkdownPreview(source, new Set());
    expect(plan.filter((p) => p.kind === "link").map((p) => p.href)).toEqual([
      "https://x.com",
      "https://example.com",
      "https://example.com",
    ]);
    expect(plan.some((p) => p.className === "md-preview-strong")).toBe(true);
    expect(plan.some((p) => p.className === "md-preview-definition")).toBe(
      true,
    );
  });

  it("never reveals source in read-only cards and preserves CRLF source", () => {
    const source = "# One\r\n\r\n**two**  \r\n";
    const state = EditorState.create({
      doc: source,
      extensions: [
        EditorState.readOnly.of(true),
        EditorState.lineSeparator.of("\n"),
      ],
    });
    expect([...activeSourceLines(state, true)]).toEqual([]);
    expect(state.doc.toString()).toBe(source);
    expect(
      planMarkdownPreview(source, new Set())
        .filter((p) => p.kind === "hide")
        .map((p) => source.slice(p.from, p.to)),
    ).toEqual(["# ", "**", "**"]);
  });

  it("applies external undo as a minimal change and rejects over-limit editing", () => {
    expect(
      externalDocumentChange("before **text** after", "before *text* after"),
    ).toEqual({ from: 8, to: 14, insert: "text" });
    const state = EditorState.create({
      doc: "a".repeat(200000),
      extensions: [limitMarkdownLength],
    });
    expect(
      state.update({ changes: { from: 200000, insert: "b" } }).newDoc.length,
    ).toBe(200000);
    expect(
      state
        .update({ changes: { from: 199999, to: 200000, insert: "b" } })
        .newDoc.sliceString(199998),
    ).toBe("ab");
  });
});
