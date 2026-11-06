// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectGitButton from "../src/client/git/ProjectGitButton";
import { api } from "../src/client/api";
import type { GitDiff, GitStatus } from "../src/shared/project-git";

vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));

function fixture(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    state: "ready",
    projectRoot: "/project",
    root: "/project",
    branch: "main",
    head: "abc1234",
    detached: false,
    unborn: false,
    isWorktree: true,
    worktrees: [
      { path: "/project", branch: "main", head: "abc1234", current: true },
      { path: "/other", branch: "occupied", head: "abc1234", current: false },
    ],
    branches: [
      { name: "main", current: true, worktreePath: "/project" },
      { name: "feature", current: false },
      { name: "occupied", current: false, worktreePath: "/other" },
    ],
    files: [
      {
        path: "a.sql",
        indexStatus: " ",
        worktreeStatus: "M",
        conflicted: false,
      },
      {
        path: "b.sql",
        indexStatus: "A",
        worktreeStatus: " ",
        conflicted: false,
      },
    ],
    counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 },
    revision: "revision-1",
    canMutate: true,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("project Git controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ProjectGitButton>;
  let status: GitStatus;
  let writes: { url: string; body: Record<string, unknown> }[];
  let nextStatus: Promise<GitStatus> | undefined;
  let nextWrite: Promise<GitStatus> | undefined;
  let diffs: Map<string, Promise<GitDiff>>;

  function button(label: string) {
    const match = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (element) =>
        element.getAttribute("aria-label") === label ||
        element.textContent === label,
    );
    expect(match, label).toBeTruthy();
    return match!;
  }
  function field<T extends HTMLInputElement | HTMLTextAreaElement>(
    label: string,
  ) {
    const match = document.querySelector<T>(`[aria-label="${label}"]`);
    expect(match, label).toBeTruthy();
    return match!;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  async function input(label: string, value: string) {
    const element = field(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function select(path = "a.sql") {
    await act(async () =>
      field<HTMLInputElement>(`Включить ${path} в коммит`).click(),
    );
  }
  async function render(overrides: Partial<typeof props> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(createElement(ProjectGitButton, props)));
  }
  async function open() {
    await render();
    await click("Git проекта");
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    status = fixture();
    writes = [];
    diffs = new Map();
    nextStatus = undefined;
    nextWrite = undefined;
    vi.mocked(api).mockReset();
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (options?.method === "POST") {
        const body = JSON.parse(options.body as string);
        writes.push({ url, body });
        if (nextWrite) return nextWrite;
        status = fixture({
          files: [],
          revision: "revision-2",
          branch: body.branch || body.name || "main",
          counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        });
        return status;
      }
      if (url.startsWith("/api/project/git/diff?")) {
        const path = new URL(url, "http://localhost").searchParams.get("path")!;
        return (
          diffs.get(path) || {
            path,
            patch: `--- a/${path}\n+++ b/${path}\n-old\n+new`,
            truncated: false,
            binary: false,
            revision: status.revision,
          }
        );
      }
      if (nextStatus) {
        const value = nextStatus;
        nextStatus = undefined;
        return value;
      }
      return status;
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = {
      workspaceId: "project",
      hasUnsavedFiles: false,
      onNotify: vi.fn(),
      onBeforeMutation: vi.fn(async () => {}),
      onBranchChanged: vi.fn(async () => {}),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("commits only explicitly checked files with the viewed revision and a message", async () => {
    await open();
    expect(button("Git проекта").title).toContain("main");
    expect(button("Git проекта").textContent).toContain("2");
    expect(field<HTMLInputElement>("Включить a.sql в коммит").checked).toBe(
      false,
    );
    expect(field<HTMLInputElement>("Включить b.sql в коммит").checked).toBe(
      false,
    );
    await input("Сообщение коммита", "  Update query  ");
    expect(button("Коммит выбранных").disabled).toBe(true);
    await select();
    await click("Коммит выбранных");
    expect(writes).toEqual([
      {
        url: "/api/project/git/commit",
        body: {
          paths: ["a.sql"],
          message: "Update query",
          revision: "revision-1",
        },
      },
    ]);
    expect(props.onBeforeMutation).toHaveBeenCalledTimes(1);
    expect(props.onBranchChanged).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Нет изменений");
    expect(field<HTMLTextAreaElement>("Сообщение коммита").value).toBe("");
  });

  it("blocks writes for unsaved editor drafts and for a server mutation lock", async () => {
    await open();
    await select();
    await input("Сообщение коммита", "Update");
    await render({ hasUnsavedFiles: true });
    expect(button("Коммит выбранных").disabled).toBe(true);
    expect(document.body.textContent).toContain("несохранённые файлы");
    await click("Ветки");
    expect(button("Переключиться на feature").disabled).toBe(true);
    expect(button("Создать и переключиться").disabled).toBe(true);
    await render({ hasUnsavedFiles: false });
    status = fixture({
      canMutate: false,
      mutationBlockedReason: "Агент изменяет проект",
    });
    await click("Обновить Git");
    expect(document.body.textContent).toContain("Агент изменяет проект");
    await click("Изменения");
    expect(button("Коммит выбранных").disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it("allows clean branch switching and creation while disabling branches occupied by another worktree", async () => {
    status = fixture({
      files: [],
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    await open();
    await click("Ветки");
    expect(button("Переключиться на occupied").disabled).toBe(true);
    await click("Переключиться на feature");
    expect(writes[0]).toEqual({
      url: "/api/project/git/switch",
      body: { branch: "feature", revision: "revision-1" },
    });
    expect(button("Git проекта").title).toContain("feature");
    expect(props.onBranchChanged).toHaveBeenCalledTimes(1);
    await input("Имя новой ветки", "  topic/test  ");
    await click("Создать и переключиться");
    expect(writes[1]).toEqual({
      url: "/api/project/git/branches",
      body: { name: "topic/test", revision: "revision-2" },
    });
    expect(props.onBranchChanged).toHaveBeenCalledTimes(2);
    await click("Worktree");
    expect(document.body.textContent).toContain("/other");
    expect(document.body.textContent).toContain("Текущий");
  });

  it("keeps the successful mutation status when an earlier refresh resolves late", async () => {
    await open();
    await select();
    await input("Сообщение коммита", "Update");
    const stale = deferred<GitStatus>();
    nextStatus = stale.promise;
    await click("Обновить Git");
    await click("Коммит выбранных");
    await act(async () => stale.resolve(fixture({ branch: "stale-branch" })));
    expect(button("Git проекта").title).not.toContain("stale-branch");
    expect(document.body.textContent).toContain("Нет изменений");
  });

  it("keeps a newer file diff when an older selection resolves late", async () => {
    const stale = deferred<GitDiff>();
    diffs.set("a.sql", stale.promise);
    await open();
    await click("Посмотреть изменения a.sql");
    await click("Посмотреть изменения b.sql");
    expect(document.querySelector(".git-diff")?.textContent).toContain(
      "b/b.sql",
    );
    await act(async () =>
      stale.resolve({
        path: "a.sql",
        patch: "stale patch",
        truncated: false,
        binary: false,
        revision: "revision-1",
      }),
    );
    expect(document.querySelector(".git-diff")?.textContent).not.toContain(
      "stale patch",
    );
    expect(document.querySelector(".git-diff")?.textContent).toContain(
      "b/b.sql",
    );
  });

  it("retains the selected files and message after a failed commit and prevents duplicate pending actions", async () => {
    await open();
    await select();
    await input("Сообщение коммита", "Keep this draft");
    const pending = deferred<GitStatus>();
    nextWrite = pending.promise;
    await click("Коммит выбранных");
    expect(button("Коммит выбранных").disabled).toBe(true);
    await click("Коммит выбранных");
    expect(writes).toHaveLength(1);
    await act(async () =>
      pending.reject(new Error("Repository changed; refresh")),
    );
    expect(field<HTMLTextAreaElement>("Сообщение коммита").value).toBe(
      "Keep this draft",
    );
    expect(field<HTMLInputElement>("Включить a.sql в коммит").checked).toBe(
      true,
    );
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "Repository changed",
    );
  });

  it("does not send a write when the final draft guard rejects it", async () => {
    await render({
      onBeforeMutation: async () => {
        throw new Error("New unsaved file");
      },
    });
    await click("Git проекта");
    await select();
    await input("Сообщение коммита", "Update");
    await click("Коммит выбранных");
    expect(writes).toEqual([]);
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "New unsaved file",
    );
  });

  it("refreshes open files after an external checkout but not on initial load or unchanged status", async () => {
    await open();
    expect(props.onBranchChanged).not.toHaveBeenCalled();
    await click("Обновить Git");
    expect(props.onBranchChanged).not.toHaveBeenCalled();
    status = fixture({
      branch: "external",
      head: "def5678",
      revision: "revision-external",
    });
    await click("Обновить Git");
    expect(button("Git проекта").title).toContain("external");
    expect(props.onBranchChanged).toHaveBeenCalledTimes(1);
    await click("Обновить Git");
    expect(props.onBranchChanged).toHaveBeenCalledTimes(1);
  });

  it("recovers from an invalid status response without rendering unsafe actions", async () => {
    nextStatus = Promise.resolve([] as unknown as GitStatus);
    await render();
    expect(button("Git проекта").getAttribute("aria-label")).toBe(
      "Git проекта",
    );
    await click("Git проекта");
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(field<HTMLInputElement>("Включить a.sql в коммит").checked).toBe(
      false,
    );
  });

  it("polls only while the document is visible and refreshes on focus", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    await render();
    status = fixture({ branch: "poll-update" });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(button("Git проекта").title).toContain("poll-update");
    visibility.mockReturnValue("hidden");
    status = fixture({ branch: "hidden-update" });
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(button("Git проекта").title).toContain("poll-update");
    visibility.mockReturnValue("visible");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button("Git проекта").title).toContain("hidden-update");
  });

  it("restores focus to the Git trigger after closing the dialog with Escape", async () => {
    await open();
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(button("Git проекта"));
  });

  it("requires the first commit before creating or switching branches", async () => {
    status = fixture({
      unborn: true,
      head: null,
      files: [],
      branches: [],
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    await open();
    expect(document.body.textContent).toContain("Первый коммит ещё не создан");
    await click("Ветки");
    await input("Имя новой ветки", "topic");
    expect(button("Создать и переключиться").disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it("blocks commits until every conflict is resolved, even when a clean file was selected", async () => {
    status = fixture({
      files: [
        ...fixture().files,
        {
          path: "conflict.sql",
          indexStatus: "U",
          worktreeStatus: "U",
          conflicted: true,
        },
      ],
      counts: { staged: 2, unstaged: 2, untracked: 0, conflicted: 1 },
    });
    await open();
    await select();
    await input("Сообщение коммита", "Update");
    expect(button("Коммит выбранных").disabled).toBe(true);
    expect(document.body.textContent).toContain("разрешите конфликты");
    expect(writes).toEqual([]);
  });

  it.each(["not_repository", "unavailable"] as const)(
    "explains %s and refreshes without exposing writes",
    async (state) => {
      status = fixture({
        state,
        files: [],
        canMutate: false,
        message: "Git is unavailable here",
      });
      await open();
      expect(document.body.textContent).toContain("Git is unavailable here");
      expect(
        document.querySelector('[aria-label="Сообщение коммита"]'),
      ).toBeNull();
      expect(button("Обновить Git").disabled).toBe(false);
      expect(document.body.textContent).toContain(
        "сохранённые запросы, доски и презентации",
      );
    },
  );
});
