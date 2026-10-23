import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  activeSourceLines,
  planMarkdownPreview,
  externalDocumentChange,
  limitMarkdownLength,
} from "../src/client/board/markdown-live-preview";

describe("Markdown live preview", () => {
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
