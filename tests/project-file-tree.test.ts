// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectFileTree from "../src/client/components/ProjectFileTree";
import { api } from "../src/client/api";
import type { ProjectTextFile, ProjectTree } from "../src/shared/project-files";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

const rootTree: ProjectTree = {
  path: "",
  entries: [
    { path: "docs", name: "docs", kind: "directory" },
    { path: "README.md", name: "README.md", kind: "file" },
    { path: "settings.json", name: "settings.json", kind: "file" },
  ],
  truncated: false,
};
const docsTree: ProjectTree = {
  path: "docs",
  entries: [{ path: "docs/guide.md", name: "guide.md", kind: "file" }],
  truncated: false,
};
function file(path: string): ProjectTextFile {
  return {
    path,
    name: path.split("/").at(-1)!,
    content: "hello",
    revision: "abc",
    size: 5,
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("project file tree", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ProjectFileTree>;
  const onOpenFile = vi.fn();
  const onNotify = vi.fn();
  async function render(change: Partial<typeof props> = {}) {
    props = { ...props, ...change };
    await act(async () => root.render(createElement(ProjectFileTree, props)));
  }
  function item(path: string) {
    const result = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'),
    ].find((node) => node.title === path);
    expect(result, `Missing tree item ${path}`).toBeTruthy();
    return result!;
  }
  async function click(path: string) {
    await act(async () => item(path).click());
  }
  async function key(path: string, value: string) {
    await act(async () =>
      item(path).dispatchEvent(
        new KeyboardEvent("keydown", { key: value, bubbles: true }),
      ),
    );
  }
  function tree() {
    return container.querySelector<HTMLDivElement>('[role="tree"]')!;
  }
  async function drag(
    path: string,
    target: () => HTMLElement,
    checkEnter = false,
  ) {
    const data = new Map<string, string>();
    const transfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) || "",
    };
    const dispatch = (node: HTMLElement, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      node.dispatchEvent(event);
      return event;
    };
    await act(async () => dispatch(item(path), "dragstart"));
    await act(async () => {
      const enter = dispatch(target(), "dragenter");
      if (checkEnter) {
        expect(enter.defaultPrevented).toBe(true);
        expect(transfer.dropEffect).toBe("move");
      }
      dispatch(target(), "dragover");
      dispatch(target(), "drop");
    });
  }

  it("moves dragged files into folders and back to the root", async () => {
    const moved: { path: string; directory: string }[] = [];
    await render({
      onMoveFile: async (input) => {
        moved.push(input);
        return {
          from: input.path,
          path: input.directory
            ? `${input.directory}/${input.path.split("/").at(-1)}`
            : input.path.split("/").at(-1)!,
          name: input.path.split("/").at(-1)!,
        };
      },
    });
    expect(item("README.md").draggable).toBe(true);
    expect(item("docs").draggable).toBe(false);
    await drag("README.md", () => item("docs"));
    const treeRows = [...tree().querySelectorAll('[role="treeitem"]')];
    await drag("docs/guide.md", () => {
      expect([...tree().querySelectorAll('[role="treeitem"]')]).toEqual(
        treeRows,
      );
      expect(tree().textContent).toContain("Переместить в корень проекта");
      return tree();
    });
    expect(moved).toEqual([
      { path: "README.md", directory: "docs" },
      { path: "docs/guide.md", directory: "" },
    ]);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("reports failed moves and retains the source row", async () => {
    await render({
      onMoveFile: async () => {
        throw new Error("Имя уже занято");
      },
    });
    await drag("README.md", () => item("docs"));
    expect(onNotify).toHaveBeenCalledWith("Имя уже занято", "error");
    expect(item("README.md")).toBeTruthy();
  });

  it("accepts root drops on tree background without adding a toolbar button", async () => {
    const toolbar = document.body.appendChild(document.createElement("div"));
    const moves: { path: string; directory: string }[] = [];
    try {
      await render({
        actionsTarget: toolbar,
        onMoveFile: async (input) => {
          moves.push(input);
          return { from: input.path, path: "guide.md", name: "guide.md" };
        },
      });
      expect(toolbar.querySelectorAll("button")).toHaveLength(2);
      expect(toolbar.textContent).not.toContain("Корень проекта");
      expect(tree().textContent).not.toContain("Переместить в корень проекта");
      await click("docs");
      await drag("docs/guide.md", tree, true);
      expect(moves).toEqual([{ path: "docs/guide.md", directory: "" }]);
      expect(tree().textContent).not.toContain("Переместить в корень проекта");
      expect(onNotify).toHaveBeenCalledWith(
        "Файл guide.md перемещён",
        "success",
      );
    } finally {
      toolbar.remove();
    }
  });

  it("does not turn no-op folder drops or drops on file rows into root moves", async () => {
    const move = vi.fn();
    const bubbled = vi.fn();
    await render({ onMoveFile: move });
    await click("docs");
    document.addEventListener("drop", bubbled);
    try {
      await drag("docs/guide.md", () => item("docs"));
      expect(bubbled).not.toHaveBeenCalled();
      await drag("docs/guide.md", () => item("README.md"));
      expect(move).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("drop", bubbled);
    }
  });

  it.each([
    ["dragenter", "README.md"],
    ["dragover", "README.md"],
    ["dragenter", "docs"],
    ["dragover", "docs"],
  ])(
    "clears root highlight on %s over invalid target %s",
    async (eventType, path) => {
      const move = vi.fn();
      await render({ onMoveFile: move });
      await click("docs");
      const transfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
      const dispatch = async (
        node: HTMLElement,
        type: string,
        relatedTarget: HTMLElement | null = null,
      ) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          dataTransfer: { value: transfer },
          relatedTarget: { value: relatedTarget },
        });
        await act(async () => node.dispatchEvent(event));
        return event;
      };
      await dispatch(item("docs/guide.md"), "dragstart");
      await dispatch(tree(), "dragenter");
      expect(tree().classList.contains("project-root-drop-active")).toBe(true);
      await dispatch(tree(), "dragleave", item(path));
      const rejected = await dispatch(item(path), eventType);
      expect(rejected.defaultPrevented).toBe(false);
      expect(tree().classList.contains("project-root-drop-active")).toBe(false);
      await dispatch(item(path), "drop");
      expect(move).not.toHaveBeenCalled();
    },
  );

  it("clears selection from whitespace and Escape while keeping the open file and keyboard navigation", async () => {
    await render();
    await click("docs");
    await click("docs/guide.md");
    await act(async () => tree().click());
    expect(tree().querySelector('[aria-selected="true"]')).toBeNull();
    expect(document.activeElement).toBe(tree());
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    await act(async () =>
      tree().dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(item("docs"));
    const escaped = vi.fn();
    document.addEventListener("keydown", escaped);
    try {
      await key("docs", "Escape");
      expect(escaped).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", escaped);
    }
    expect(tree().querySelector('[aria-selected="true"]')).toBeNull();
    expect(item("docs").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(tree());
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api).mockImplementation(async (url) => {
      const request = new URL(url, "http://localhost");
      const path = request.searchParams.get("path") || "";
      if (request.pathname === "/api/project/tree")
        return path ? docsTree : rootTree;
      if (request.pathname === "/api/project/file") return file(path);
      return { files: [], truncated: false };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      workspaceId: "test-project",
      filter: "",
      revision: 0,
      onOpenFile,
      onNotify,
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads folders lazily, preserves expansion, and opens the selected file", async () => {
    await render();
    expect(vi.mocked(api).mock.calls.map(([url]) => url)).toEqual([
      "/api/project/tree?path=",
    ]);
    expect(item("docs").getAttribute("aria-expanded")).toBe("false");
    await click("docs");
    expect(item("docs/guide.md").getAttribute("aria-level")).toBe("2");
    expect(
      JSON.parse(localStorage.getItem("miracle:project-tree:test-project")!),
    ).toEqual(["docs"]);
    await click("docs/guide.md");
    expect(onOpenFile).toHaveBeenCalledWith(file("docs/guide.md"));
    expect(item("docs/guide.md").getAttribute("aria-selected")).toBe("true");
    expect(item("docs/guide.md").getAttribute("aria-busy")).toBe("false");
    await click("docs");
    expect(container.querySelector('[title="docs/guide.md"]')).toBeNull();
    await click("docs");
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(([url]) => url === "/api/project/tree?path=docs"),
    ).toHaveLength(1);
  });

  it("navigates visible folders and files with arrows, Home, and End", async () => {
    await render();
    item("docs").focus();
    await key("docs", "ArrowRight");
    expect(item("docs").getAttribute("aria-expanded")).toBe("true");
    await key("docs", "ArrowRight");
    expect(document.activeElement).toBe(item("docs/guide.md"));
    await key("docs/guide.md", "ArrowLeft");
    expect(document.activeElement).toBe(item("docs"));
    await key("docs", "End");
    expect(document.activeElement).toBe(item("settings.json"));
    await key("settings.json", "ArrowUp");
    expect(document.activeElement).toBe(item("README.md"));
    await key("README.md", "Home");
    expect(document.activeElement).toBe(item("docs"));
    await key("docs", "ArrowLeft");
    expect(item("docs").getAttribute("aria-expanded")).toBe("false");
    await key("docs", "ArrowDown");
    expect(document.activeElement).toBe(item("README.md"));
  });

  it("keeps the latest clicked file when an older request resolves later", async () => {
    await render();
    const older = deferred<ProjectTextFile>();
    vi.mocked(api).mockImplementationOnce(() => older.promise);
    await click("README.md");
    const oldSignal = vi.mocked(api).mock.calls.at(-1)![1]?.signal;
    await click("settings.json");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => older.resolve(file("README.md")));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith(file("settings.json"));
    expect(item("settings.json").getAttribute("aria-selected")).toBe("true");
  });

  it("discards stale search results and restores the folder tree on clearing search", async () => {
    await render();
    await click("docs");
    const older = deferred<{ files: string[]; truncated: boolean }>();
    const newer = deferred<{ files: string[]; truncated: boolean }>();
    vi.mocked(api)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    await render({ filter: "old" });
    await act(async () => vi.advanceTimersByTime(180));
    const oldSignal = vi.mocked(api).mock.calls.at(-1)![1]?.signal;
    await render({ filter: "guide" });
    await act(async () => vi.advanceTimersByTime(180));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () =>
      newer.resolve({ files: ["docs/guide.md"], truncated: true }),
    );
    await act(async () =>
      older.resolve({ files: ["old.txt"], truncated: false }),
    );
    expect(container.textContent).toContain("guide.md");
    expect(container.textContent).toContain("docs");
    expect(container.textContent).not.toContain("old.txt");
    expect(container.textContent).toContain("Уточните поиск");
    await render({ filter: "" });
    expect(item("docs").getAttribute("aria-expanded")).toBe("true");
    expect(item("docs/guide.md")).toBeTruthy();
  });

  it("retains expanded folders when refreshing and rejects the prior listing response", async () => {
    await render();
    await click("docs");
    const stale = deferred<ProjectTree>();
    vi.mocked(api).mockImplementationOnce(() => stale.promise);
    await render({ revision: 1 });
    const signal = vi
      .mocked(api)
      .mock.calls.filter(([url]) => url === "/api/project/tree?path=")
      .at(-1)?.[1]?.signal;
    await render({ revision: 2 });
    await act(async () =>
      stale.resolve({ path: "", entries: [], truncated: false }),
    );
    expect(signal?.aborted).toBe(true);
    expect(item("docs").getAttribute("aria-expanded")).toBe("true");
    expect(item("docs/guide.md")).toBeTruthy();
  });

  it("shows directory errors with a retry and reports unsupported file errors without opening a tab", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Нет доступа к папке"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Нет доступа",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[role="alert"] button')!
        .click(),
    );
    expect(item("README.md")).toBeTruthy();
    vi.mocked(api).mockRejectedValueOnce(
      new Error("Редактор поддерживает текстовые файлы в кодировке UTF-8"),
    );
    await click("README.md");
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("UTF-8"),
      "error",
    );
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(item("README.md").getAttribute("aria-busy")).toBe("false");
  });

  it("restores expanded folders per workspace and handles empty folders", async () => {
    localStorage.setItem(
      "miracle:project-tree:test-project",
      JSON.stringify(["docs"]),
    );
    vi.mocked(api).mockImplementation(async (url) =>
      url.endsWith("path=docs")
        ? { path: "docs", entries: [], truncated: false }
        : rootTree,
    );
    await render();
    expect(item("docs").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Папка пуста");
  });
});
