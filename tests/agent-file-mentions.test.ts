// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentComposer from "../src/client/agents/AgentComposer";
import { AgentContextChips } from "../src/client/agents/AgentFileMentions";
import { api } from "../src/client/api";
import type { AgentChatState } from "../src/client/agents/useAgentChat";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
let root: Root, host: HTMLDivElement;
const send = vi.fn(async () => {});
const dismissBoard = vi.fn();
const chat = {
  selected: "chat",
  profiles: [{ id: "profile", name: "Codex", trusted: true }],
  conversation: null,
  active: null,
  busy: false,
  chats: [],
  setSelected: vi.fn(),
} as unknown as AgentChatState;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api).mockResolvedValue({
    files: ["sql/monthly.sql", "data/Мои данные.csv"],
    truncated: false,
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function Harness({
  initial = "",
  files = [],
}: {
  initial?: string;
  files?: string[];
}) {
  const [draft, setDraft] = useState(initial);
  const [selected, setSelected] = useState(files);
  return createElement(AgentComposer, {
    state: chat,
    selectedProfile: "profile",
    onProfileChange: vi.fn(),
    draft,
    onDraftChange: setDraft,
    onSend: send,
    onSettings: vi.fn(),
    filePaths: selected,
    onFilesChange: setSelected,
    boardNodes: [{ id: "chart", title: "Поездки по дням" }],
    onDismissBoardNode: dismissBoard,
  });
}
async function render(initial = "", files: string[] = []) {
  await act(async () =>
    root.render(createElement(Harness, { initial, files })),
  );
}
const textarea = () => host.querySelector("textarea")!;
async function input(value: string, caret = value.length) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea(), value);
    textarea().setSelectionRange(caret, caret);
    textarea().focus();
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function results() {
  await act(async () => vi.advanceTimersByTimeAsync(160));
}
async function key(key: string, extra: KeyboardEventInit = {}) {
  await act(async () =>
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    ),
  );
}
const options = () => [
  ...host.querySelectorAll<HTMLButtonElement>('[role="option"]'),
];

it("selects a project file at the caret without replacing surrounding text, then removes its chip", async () => {
  await render();
  await input("Проверь @Мои и сравни", "Проверь @Мои".length);
  await results();
  expect(api).toHaveBeenCalledWith(
    "/api/project/files?q=%D0%9C%D0%BE%D0%B8",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await act(async () => options()[1].click());
  expect(textarea().value).toBe("Проверь  и сравни");
  expect(textarea().selectionStart).toBe("Проверь ".length);
  expect(document.activeElement).toBe(textarea());
  const chip = host.querySelector<HTMLButtonElement>(
    '[aria-label="Убрать файл data/Мои данные.csv"]',
  );
  expect(chip).not.toBeNull();
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => chip!.click());
  expect(
    host.querySelector('[aria-label="Убрать файл data/Мои данные.csv"]'),
  ).toBeNull();
});

it("uses arrows and Enter to select without submitting, and Escape closes only suggestions", async () => {
  await render();
  await input("Сравни @");
  await results();
  await key("ArrowDown");
  expect(textarea().getAttribute("aria-activedescendant")).toBe(
    options()[1].id,
  );
  await key("Enter");
  expect(send).not.toHaveBeenCalled();
  expect(
    host.querySelector('[aria-label="Убрать файл data/Мои данные.csv"]'),
  ).not.toBeNull();
  await input("Сравни @sql");
  await results();
  const parentKey = vi.fn();
  document.body.addEventListener("keydown", parentKey);
  await key("Escape");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(parentKey).not.toHaveBeenCalled();
  document.body.removeEventListener("keydown", parentKey);
  await key("Enter", { ctrlKey: true });
  expect(send).toHaveBeenCalledOnce();
});

it("ignores email mentions and composing Enter, and keeps board context removable", async () => {
  await render();
  await input("email@example.com");
  await results();
  expect(api).not.toHaveBeenCalled();
  await input("Проверь @");
  await results();
  await key("Enter", { isComposing: true });
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  expect(send).not.toHaveBeenCalled();
  const parentKey = vi.fn();
  document.body.addEventListener("keydown", parentKey);
  await key("Escape", { isComposing: true });
  document.body.removeEventListener("keydown", parentKey);
  expect(parentKey).not.toHaveBeenCalled();
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  const chip = host.querySelector<HTMLButtonElement>(
    '[aria-label="Убрать из контекста Поездки по дням"]',
  );
  expect(chip).not.toBeNull();
  await act(async () => chip!.click());
  expect(dismissBoard).toHaveBeenCalledWith("chart");
});

it("aborts obsolete searches and ignores a late response, including after dismissal", async () => {
  let first!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        first = resolve;
      }),
  );
  await render();
  await input("@old");
  await results();
  const signal = vi.mocked(api).mock.calls[0][1]!.signal!;
  await input("@new");
  await results();
  expect(signal.aborted).toBe(true);
  await act(async () => first({ files: ["old.sql"], truncated: false }));
  expect(options().map((option) => option.textContent)).not.toContain(
    "old.sql",
  );
  let dismissed!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        dismissed = resolve;
      }),
  );
  await input("@later");
  await results();
  await key("Escape");
  await act(async () => dismissed({ files: ["later.sql"], truncated: false }));
  expect(host.querySelector('[role="listbox"]')).toBeNull();
});

it("shows empty and failed searches with retry, and never duplicates a selected file", async () => {
  vi.mocked(api).mockResolvedValueOnce({ files: [], truncated: false });
  await render("", ["sql/monthly.sql"]);
  await input("@nothing");
  await results();
  expect(host.textContent).toContain("Файлы не найдены");
  vi.mocked(api).mockRejectedValueOnce(new Error("Нет связи с проектом"));
  await input("@sql");
  await results();
  expect(host.textContent).toContain("Нет связи с проектом");
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Повторить",
  );
  await act(async () => retry!.click());
  await results();
  expect(options().map((option) => option.textContent)).not.toContain(
    "sql/monthly.sql",
  );
  await key("Tab");
  expect(host.querySelectorAll('[aria-label^="Убрать файл"]')).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
});

it("shows the file limit without starting another search", async () => {
  await render(
    "",
    Array.from({ length: 20 }, (_, n) => `${n}.sql`),
  );
  await input("@next");
  await results();
  expect(api).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Можно указать до 20 файлов");
});

it("shows persisted references without removal controls in message history", async () => {
  await act(async () =>
    root.render(
      createElement(AgentContextChips, {
        filePaths: ["data/Мои данные.csv"],
        boardNodes: [{ id: "chart", title: "Поездки по дням" }],
      }),
    ),
  );
  expect(host.textContent).toContain("data/Мои данные.csv");
  expect(host.textContent).toContain("Поездки по дням");
  expect(host.querySelector("button")).toBeNull();
});
