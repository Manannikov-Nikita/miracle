// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { URI } from "monaco-editor/base/common/uri.js";
import ProjectTextEditor from "../src/client/components/ProjectTextEditor";
import { findSearchMatch } from "../src/shared/workspace-search";

const harness = vi.hoisted(() => ({
  selection: vi.fn(),
  reveal: vi.fn(),
  focus: vi.fn(),
  modelPaths: [] as string[],
}));

// Keep Monaco's actual URI parser: it canonicalizes encoded path separators,
// unlike comparing the React path prop literally against model.uri.toString().
vi.mock("monaco-editor/editor/editor.api.js", async () => {
  const { URI } = await import("monaco-editor/base/common/uri.js");
  const { Range } = await import("monaco-editor/editor/common/core/range.js");
  return {
    Uri: URI,
    Range,
    editor: { setModelLanguage() {} },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
  };
});
vi.mock("@monaco-editor/react", async () => {
  const { useEffect, useRef, createElement } = await import("react");
  const { URI } = await import("monaco-editor/base/common/uri.js");
  return {
    default: (props: {
      path: string;
      value: string;
      onMount: (editor: unknown) => void;
    }) => {
      harness.modelPaths.push(props.path);
      const latest = useRef(props);
      latest.current = props;
      useEffect(() => {
        props.onMount({
          getModel: () => ({
            uri: URI.parse(latest.current.path),
            getValue: () => latest.current.value,
            getPositionAt: (offset: number) => {
              const lines = latest.current.value.slice(0, offset).split("\n");
              return {
                lineNumber: lines.length,
                column: lines.at(-1)!.length + 1,
              };
            },
          }),
          setSelection: harness.selection,
          revealRangeInCenter: harness.reveal,
          focus: harness.focus,
          addCommand() {},
          getPosition: () => ({ lineNumber: 1, column: 1 }),
          onDidChangeCursorPosition: () => ({ dispose() {} }),
          onDidChangeModel: () => ({ dispose() {} }),
        });
      }, []);
      return createElement("textarea", { value: props.value, readOnly: true });
    },
  };
});
vi.mock("../src/client/file-highlighting", () => ({
  ensureFileLanguage: async () => {},
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  harness.modelPaths = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("keeps the same Monaco model when the open file moves to another folder", async () => {
  const props: ComponentProps<typeof ProjectTextEditor> = {
    workspaceId: "moving-project",
    file: {
      id: "stable-file-id",
      path: "settings.json",
      name: "settings.json",
      content: "dirty",
      savedContent: "saved",
      revision: "disk-v1",
      size: 5,
      updatedAt: "now",
    },
    saving: false,
    onChange: vi.fn(),
    onSave: vi.fn(),
  };
  await act(async () => root.render(createElement(ProjectTextEditor, props)));
  const modelPath = harness.modelPaths.at(-1);
  await act(async () =>
    root.render(
      createElement(ProjectTextEditor, {
        ...props,
        file: { ...props.file, path: "docs/settings.json" },
      }),
    ),
  );
  expect(harness.modelPaths.at(-1)).toBe(modelPath);
  expect(container.querySelector("textarea")?.value).toBe("dirty");
  expect(container.querySelector(".project-file-path")?.textContent).toBe(
    "docs/settings.json",
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(["docs/settings.json", "данные/параметры.json"])(
  "reveals a match in a nested text file using the actual Monaco URI for %s",
  async (path) => {
    const content = '{\n  "message": "needle"\n}';
    const rawUri = `miracle-query://search-project/${encodeURIComponent(path)}.sql`;
    expect(URI.parse(rawUri).toString()).not.toBe(rawUri);
    const props: ComponentProps<typeof ProjectTextEditor> = {
      workspaceId: "search-project",
      file: {
        id: path,
        path,
        name: path.split("/").at(-1)!,
        content,
        savedContent: content,
        revision: "disk-v1",
        size: content.length,
        updatedAt: "now",
      },
      saving: false,
      onChange: vi.fn(),
      onSave: vi.fn(),
      revealRequest: {
        requestId: "nested-hit",
        match: findSearchMatch(content, "needle")!,
      },
      onRevealComplete: vi.fn(),
    };
    await act(async () => root.render(createElement(ProjectTextEditor, props)));
    expect(harness.selection).toHaveBeenCalledWith(
      expect.objectContaining({
        startLineNumber: 2,
        startColumn: 15,
        endLineNumber: 2,
        endColumn: 21,
      }),
    );
    expect(harness.reveal).toHaveBeenCalledOnce();
    expect(harness.focus).toHaveBeenCalledOnce();
    expect(props.onRevealComplete).toHaveBeenCalledWith("nested-hit", true);
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
  },
);
