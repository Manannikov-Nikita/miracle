// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProjectFileTree from "../src/client/components/ProjectFileTree";
import { api } from "../src/client/api";
import type { ProjectTreeEntry } from "../src/shared/project-files";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
let container: HTMLDivElement, root: Root;
let entries: ProjectTreeEntry[];
let props: ComponentProps<typeof ProjectFileTree>;
const onOpen = vi.fn();
const moved = vi.fn();
const deleted = vi.fn();
const parent = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));
function row(path: string) {
  const match = [
    ...container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].find((item) => item.title === path);
  expect(match, `tree row ${path}`).toBeTruthy();
  return match!;
}
function menuItem(name: string) {
  const match = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.includes(name));
  expect(match, `menu item ${name}`).toBeTruthy();
  return match!;
}
function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}
function button(name: string) {
  const match = [
    ...dialog().querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent === name);
  expect(match, `dialog button ${name}`).toBeTruthy();
  return match!;
}
async function click(node: HTMLElement) {
  await act(async () => node.click());
}
async function context(node: HTMLElement) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 100,
    clientY: 120,
  });
  await act(async () => node.dispatchEvent(event));
  return event;
}
async function setName(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Новое имя"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function renameKey(key: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Новое имя"]',
  )!;
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}
async function render() {
  await act(async () => root.render(createElement(ProjectFileTree, props)));
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  entries = [
    { path: "docs", name: "docs", kind: "directory" },
    { path: "docs/sub", name: "sub", kind: "directory" },
    { path: "docs/guide.md", name: "guide.md", kind: "file" },
    { path: "archive", name: "archive", kind: "directory" },
    { path: "README.md", name: "README.md", kind: "file" },
  ];
  vi.mocked(api).mockImplementation(async (url) => {
    const path =
      new URL(url, "http://localhost").searchParams.get("path") || "";
    return {
      path,
      entries: entries.filter((item) => parent(item.path) === path),
      truncated: false,
    };
  });
  moved.mockImplementation(async (input) => {
    const name = input.name ?? input.path.split("/").at(-1);
    const path = input.directory ? `${input.directory}/${name}` : name;
    entries = entries.map((item) =>
      item.path === input.path || item.path.startsWith(`${input.path}/`)
        ? {
            ...item,
            path: path + item.path.slice(input.path.length),
            name: item.path === input.path ? name : item.name,
          }
        : item,
    );
    return { from: input.path, path, name };
  });
  deleted.mockImplementation(async ({ path }) => {
    entries = entries.filter(
      (item) => item.path !== path && !item.path.startsWith(`${path}/`),
    );
    return { path };
  });
  props = {
    workspaceId: "file-actions",
    filter: "",
    revision: 0,
    onOpenFile: onOpen,
    onMoveFile: moved,
    onDeleteFile: deleted,
    onNotify: vi.fn(),
  };
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("right-click selects the target without opening files or expanding folders", async () => {
  const event = await context(row("docs"));
  expect(event.defaultPrevented).toBe(true);
  expect(row("docs").getAttribute("aria-selected")).toBe("true");
  expect(row("docs").getAttribute("aria-expanded")).toBe("false");
  expect(onOpen).not.toHaveBeenCalled();
  expect(menuItem("Переименовать")).toBeTruthy();
  expect(menuItem("Переместить")).toBeTruthy();
  expect(menuItem("Удалить")).toBeTruthy();
});

it("renames inline with Enter, keeps the extension unselected and retains errors for correction", async () => {
  await context(row("README.md"));
  await click(menuItem("Переименовать"));
  expect(dialog()).toBeNull();
  const input = row("README.md").querySelector<HTMLInputElement>("input")!;
  expect(input.value).toBe("README.md");
  await vi.waitFor(() => expect(document.activeElement).toBe(input));
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
  moved.mockRejectedValueOnce(new Error("Имя уже занято"));
  await setName("notes.md");
  await renameKey("Enter");
  expect(
    row("README.md").querySelector('[role="alert"]')?.textContent,
  ).toContain("Имя уже занято");
  expect(row("README.md")).toBeTruthy();
  await renameKey("Enter");
  expect(dialog()).toBeNull();
  expect(row("notes.md").getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector('[title="README.md"]')).toBeNull();
  expect(moved).toHaveBeenLastCalledWith({
    path: "README.md",
    directory: "",
    name: "notes.md",
  });
});

it("starts inline rename with F2 and cancels with Escape without opening a dialog", async () => {
  const target = row("README.md");
  await act(async () => {
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F2",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(dialog()).toBeNull();
  const input = row("README.md").querySelector<HTMLInputElement>("input")!;
  const nativeContext = await context(input);
  expect(nativeContext.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await setName("discarded.md");
  await renameKey("Escape");
  expect(container.querySelector('input[aria-label="Новое имя"]')).toBeNull();
  expect(moved).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(row("README.md"));
});

it("rejects invalid inline names and prevents duplicate submission while saving", async () => {
  await context(row("README.md"));
  await click(menuItem("Переименовать"));
  await setName("../notes.md");
  await renameKey("Enter");
  expect(moved).not.toHaveBeenCalled();
  expect(
    row("README.md").querySelector('[role="alert"]')?.textContent,
  ).toContain("без разделителей пути");
  let reject!: (error: Error) => void;
  moved.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  await setName("notes.md");
  await renameKey("Enter");
  await renameKey("Enter");
  await renameKey("Escape");
  expect(moved).toHaveBeenCalledTimes(1);
  expect(
    row("README.md").querySelector<HTMLInputElement>("input")!.disabled,
  ).toBe(true);
  expect(row("archive").getAttribute("draggable")).toBe("false");
  await act(async () => reject(new Error("Ошибка записи")));
  expect(
    row("README.md").querySelector<HTMLInputElement>("input")!.disabled,
  ).toBe(false);
  expect(row("README.md").querySelector<HTMLInputElement>("input")!.value).toBe(
    "notes.md",
  );
});

it("moves a folder through the destination picker while excluding its own subtree", async () => {
  await context(row("docs"));
  await click(menuItem("Переместить"));
  expect(dialog().querySelector('[data-folder-path="docs"]')).toBeNull();
  expect(dialog().textContent).toContain("Корень проекта");
  await click(
    dialog().querySelector<HTMLElement>('[data-folder-path="archive"]')!,
  );
  await click(button("Переместить"));
  expect(moved).toHaveBeenCalledWith({ path: "docs", directory: "archive" });
  expect(dialog()).toBeNull();
  expect(row("archive/docs")).toBeTruthy();
  expect(container.querySelector('[title="docs"]')).toBeNull();
});

it("requires confirmation before deleting and explains that open drafts remain", async () => {
  await context(row("docs"));
  await click(menuItem("Удалить"));
  expect(dialog().textContent).toContain("содержимым");
  expect(dialog().textContent).toContain("черновик");
  expect(deleted).not.toHaveBeenCalled();
  await click(button("Отмена"));
  expect(deleted).not.toHaveBeenCalled();
  await context(row("docs"));
  await click(menuItem("Удалить"));
  await click(button("Удалить"));
  expect(deleted).toHaveBeenCalledWith({ path: "docs" });
  expect(container.querySelector('[title="docs"]')).toBeNull();
});

it("opens the menu with Shift+F10 and returns focus on Escape", async () => {
  const item = row("README.md");
  await act(async () => {
    item.focus();
    item.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(menuItem("Переименовать")).toBeTruthy();
  await act(async () =>
    document.querySelector('[role="menu"]')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(item));
});

it("offers creation at the root on background right-click and preserves native input menus", async () => {
  await click(row("docs"));
  const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
  await context(tree);
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(
    "Удалить",
  );
  await click(menuItem("Новый файл"));
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Имя нового файла"]',
  )!;
  expect(input.closest("form")?.getAttribute("aria-label")).toContain(
    "корень проекта",
  );
  const event = await context(input);
  expect(event.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("keeps expanded descendants visible after renaming their folder", async () => {
  await click(row("docs"));
  await click(row("docs/sub"));
  await context(row("docs"));
  await click(menuItem("Переименовать"));
  await setName("manuals");
  await renameKey("Enter");
  expect(row("manuals").getAttribute("aria-expanded")).toBe("true");
  expect(row("manuals/sub").getAttribute("aria-expanded")).toBe("true");
  expect(row("manuals/guide.md")).toBeTruthy();
});

it("retains the folder and confirmation when deletion fails", async () => {
  deleted.mockRejectedValueOnce(new Error("С файлом работает агент"));
  await context(row("docs"));
  await click(menuItem("Удалить"));
  await click(button("Удалить"));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
    "С файлом работает агент",
  );
  expect(row("docs")).toBeTruthy();
  expect(button("Удалить").disabled).toBe(false);
});

it("ignores an older open request after a rename starts", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click(row("README.md"));
  const signal = vi.mocked(api).mock.calls.at(-1)?.[1]?.signal;
  await context(row("README.md"));
  await click(menuItem("Переименовать"));
  expect(signal?.aborted).toBe(true);
  await setName("notes.md");
  await renameKey("Enter");
  await act(async () =>
    finish({
      path: "README.md",
      name: "README.md",
      content: "old",
      revision: "abc",
      size: 3,
      updatedAt: "2026-11-12T00:00:00.000Z",
    }),
  );
  expect(onOpen).not.toHaveBeenCalled();
  expect(row("notes.md")).toBeTruthy();
});

it("moves a dragged folder but rejects a drop into its own subtree", async () => {
  await click(row("docs"));
  const transfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
  async function dispatch(node: HTMLElement, type: string) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    await act(async () => node.dispatchEvent(event));
    return event;
  }
  await dispatch(row("docs"), "dragstart");
  const rejected = await dispatch(row("docs/sub"), "dragover");
  expect(rejected.defaultPrevented).toBe(false);
  await dispatch(row("docs/sub"), "drop");
  expect(moved).not.toHaveBeenCalled();
  await dispatch(row("docs"), "dragstart");
  await dispatch(row("archive"), "dragover");
  await dispatch(row("archive"), "drop");
  expect(moved).toHaveBeenCalledWith({ path: "docs", directory: "archive" });
  expect(row("archive/docs/guide.md")).toBeTruthy();
});
