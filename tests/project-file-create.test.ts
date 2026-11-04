// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectFileTree from "../src/client/components/ProjectFileTree";
import { api } from "../src/client/api";
import type { ProjectTextFile, ProjectTree } from "../src/shared/project-files";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

function document(path: string): ProjectTextFile {
  return {
    path,
    name: path.split("/").at(-1)!,
    content: "",
    revision: "a".repeat(64),
    size: 0,
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}
const tree: ProjectTree = {
  path: "",
  entries: [{ path: "docs", name: "docs", kind: "directory" }],
  truncated: false,
};
const nested: ProjectTree = {
  path: "docs",
  entries: [{ path: "docs/guide.md", name: "guide.md", kind: "file" }],
  truncated: false,
};

describe("inline project file creation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ProjectFileTree>;
  let created: ProjectTextFile[];
  const onOpenFile = vi.fn();
  const onClearFilter = vi.fn();
  const create =
    vi.fn<
      (input: { directory: string; name: string }) => Promise<ProjectTextFile>
    >();

  function button(label: string) {
    const match = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(match).toBeTruthy();
    return match!;
  }
  function item(path: string) {
    const match = [
      ...container.querySelectorAll<HTMLButtonElement>("[role=treeitem]"),
    ].find((node) => node.title === path);
    expect(match).toBeTruthy();
    return match!;
  }
  function input() {
    return container.querySelector<HTMLInputElement>(
      'input[aria-label="Имя нового файла"]',
    )!;
  }
  async function click(target: HTMLElement) {
    await act(async () => target.click());
  }
  async function name(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function render(change: Partial<typeof props> = {}) {
    props = { ...props, ...change };
    await act(async () => root.render(createElement(ProjectFileTree, props)));
  }
  async function submit() {
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    vi.clearAllMocks();
    created = [];
    create.mockImplementation(async ({ directory, name }) => {
      const result = document(directory ? `${directory}/${name}` : name);
      created.push(result);
      return result;
    });
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (options?.method === "POST")
        return create(JSON.parse(options.body as string));
      const request = new URL(url, "http://localhost");
      const path = request.searchParams.get("path") || "";
      if (request.pathname === "/api/project/tree") {
        const original = path ? nested : tree;
        return {
          ...original,
          entries: [
            ...original.entries,
            ...created
              .filter(
                (file) =>
                  file.path.slice(
                    0,
                    Math.max(0, file.path.lastIndexOf("/")),
                  ) === path,
              )
              .map((file) => ({
                path: file.path,
                name: file.name,
                kind: "file",
              })),
          ],
        };
      }
      if (request.pathname === "/api/project/file") return document(path);
      return { files: ["docs/guide.md"], truncated: false };
    });
    container = window.document.createElement("div");
    window.document.body.append(container);
    root = createRoot(container);
    props = {
      workspaceId: "create-test",
      filter: "",
      revision: 0,
      onOpenFile,
      onNotify: vi.fn(),
      onClearFilter,
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each(["analysis.custom-format", "Dockerfile"])(
    "creates %s in the root without changing its name or opening a dialog",
    async (filename) => {
      await render();
      await click(button("Создать файл"));
      expect(container.querySelector("[role=dialog]")).toBeNull();
      expect(container.querySelector("form")?.getAttribute("aria-label")).toBe(
        "Новый файл: корень проекта",
      );
      expect(window.document.activeElement).toBe(input());
      await name(filename);
      await submit();
      expect(create).toHaveBeenCalledWith({ directory: "", name: filename });
      expect(onOpenFile).toHaveBeenCalledWith(document(filename));
      expect(input()).toBeNull();
      expect(item(filename).getAttribute("aria-selected")).toBe("true");
    },
  );

  it("creates inside the selected folder, beside a selected file, then returns to the root explicitly", async () => {
    await render();
    await click(item("docs"));
    await click(button("Создать файл"));
    expect(container.querySelector("form")?.getAttribute("aria-label")).toBe(
      "Новый файл: docs",
    );
    await name("new.sql");
    await click(button("Создать файл с этим именем"));
    expect(create).toHaveBeenLastCalledWith({
      directory: "docs",
      name: "new.sql",
    });
    await click(item("docs/guide.md"));
    await click(button("Создать файл"));
    await name("рядом.md");
    await submit();
    expect(create).toHaveBeenLastCalledWith({
      directory: "docs",
      name: "рядом.md",
    });
    await click(button("Корень проекта"));
    await click(button("Создать файл"));
    await name("root.txt");
    await submit();
    expect(create).toHaveBeenLastCalledWith({
      directory: "",
      name: "root.txt",
    });
  });

  it("keeps duplicate errors and the entered name inline, then permits a corrected retry", async () => {
    create.mockRejectedValueOnce(
      new Error("Файл с таким именем уже существует"),
    );
    await render();
    await click(button("Создать файл"));
    await name("existing.txt");
    await submit();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "уже существует",
    );
    expect(input().value).toBe("existing.txt");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(window.document.activeElement).toBe(input());
    expect(onOpenFile).not.toHaveBeenCalled();
    await name("another.txt");
    expect(container.querySelector("[role=alert]")).toBeNull();
    await submit();
    expect(onOpenFile).toHaveBeenCalledWith(document("another.txt"));
  });

  it("cancels on Escape without requests and leaves Enter available for native form submission", async () => {
    await render();
    await click(button("Создать файл"));
    await name("cancel.py");
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      input().dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(false);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      input().dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(input()).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects paths locally and suppresses duplicate submissions while creation is pending", async () => {
    await render();
    await click(button("Создать файл"));
    await name("../bad.txt");
    await submit();
    expect(create).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "без разделителей пути",
    );
    let resolve!: (file: ProjectTextFile) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await name("once.json");
    await submit();
    await submit();
    expect(create).toHaveBeenCalledTimes(1);
    expect(input().disabled).toBe(true);
    expect(button("Отменить создание файла").disabled).toBe(true);
    await act(async () => resolve(document("once.json")));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("clears search and reveals the selected directory for inline creation", async () => {
    await render();
    await click(item("docs"));
    await click(item("docs/guide.md"));
    await render({ filter: "guide" });
    await click(button("Создать файл"));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
    expect(container.querySelector("form")?.getAttribute("aria-label")).toBe(
      "Новый файл: docs",
    );
    expect(window.document.activeElement).toBe(input());
  });

  it("keeps a newer file selection when creation completes after navigation", async () => {
    let resolve!: (file: ProjectTextFile) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await click(button("Создать файл"));
    await name("later.txt");
    await submit();
    await click(item("docs"));
    await click(item("docs/guide.md"));
    expect(onOpenFile).toHaveBeenCalledWith(document("docs/guide.md"));
    await act(async () => resolve(document("later.txt")));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(item("docs/guide.md").getAttribute("aria-selected")).toBe("true");
    expect(props.onNotify).toHaveBeenCalledWith(
      expect.stringContaining("later.txt"),
      "success",
    );
  });
});
