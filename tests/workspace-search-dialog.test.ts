// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WorkspaceSearch from "../src/client/components/WorkspaceSearch";
import type {
  SearchResponse,
  SearchResult,
} from "../src/shared/workspace-search";

const mocks = vi.hoisted(() => ({ api: vi.fn(), openCanvas: vi.fn() }));
vi.mock("../src/client/api", () => ({ api: mocks.api }));
vi.mock("../src/client/canvas-workspace", () => ({
  useCanvasWorkspace: () => ({ openSearchResult: mocks.openCanvas }),
}));
let root: Root;
let host: HTMLDivElement;
const onOpenFile = vi.fn();
const onOpenQuery = vi.fn();
const item = (name: string): SearchResult => ({
  key: name,
  title: name,
  subtitle: `sql/${name}.sql`,
  group: "sql",
  target: { kind: "file", path: `sql/${name}.sql`, revision: "v1" },
  snippet: { text: "select revenue", start: 7, end: 14 },
});
const response = (query: string, names: string[]): SearchResponse => ({
  query,
  groups: [{ type: "sql", total: names.length, items: names.map(item) }],
  incomplete: false,
});
const groupedResponse = (query: string): SearchResponse => ({
  query,
  groups: [
    {
      type: "boards",
      total: 1,
      items: [
        {
          key: "board",
          title: "Доходы магазина",
          subtitle: "Доска",
          group: "boards",
          target: { kind: "board", id: "board", revision: 1 },
        },
      ],
    },
    { type: "presentations", total: 0, items: [] },
    { type: "sql", total: 24, items: [item("first"), item("second")] },
    {
      type: "markdown",
      total: 1,
      items: [
        {
          key: "readme",
          title: "README.md",
          subtitle: "README.md",
          group: "markdown",
          target: { kind: "file", path: "README.md", revision: "v1" },
        },
      ],
    },
    { type: "files", total: 0, items: [] },
  ],
  incomplete: false,
});
function Harness() {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement("button", { onClick: () => setOpen(true) }, "Открыть поиск"),
    createElement(WorkspaceSearch, {
      workspaceId: "test",
      open,
      onOpenChange: setOpen,
      onOpenFile,
      onOpenQuery,
    }),
  );
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  mocks.api.mockReset();
  mocks.openCanvas.mockReset();
  onOpenFile.mockReset();
  onOpenQuery.mockReset();
  mocks.api.mockImplementation(async (url: string) =>
    response(new URL(url, "http://local").searchParams.get("q") || "", [
      "revenue",
    ]),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const input = () =>
  document.querySelector<HTMLInputElement>('[role="combobox"]')!;
async function open() {
  await act(async () => host.querySelector("button")!.click());
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(key: string) {
  await act(async () =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );
}
async function tick(ms = 250) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
it("focuses the search field, debounces typing, and shows highlighted results with type tabs", async () => {
  await open();
  expect(document.activeElement).toBe(input());
  expect(mocks.api).not.toHaveBeenCalled();
  await type("rev");
  await tick(150);
  await type("revenue");
  await tick(249);
  expect(mocks.api).not.toHaveBeenCalled();
  await tick(1);
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(mocks.api.mock.calls[0][0]).toBe("/api/search?q=revenue");
  expect(tab("SQL")).toBeDefined();
  expect(document.querySelector("mark")?.textContent).toBe("revenue");
  expect(document.body.textContent).toContain(
    "Поиск по сохранённым документам",
  );
});
it("aborts replaced requests and ignores late results", async () => {
  let resolveFirst!: (value: SearchResponse) => void;
  mocks.api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  await open();
  await type("first");
  await tick();
  const signal = mocks.api.mock.calls[0][1].signal as AbortSignal;
  await type("second");
  expect(signal.aborted).toBe(true);
  await tick();
  await act(async () => resolveFirst(response("first", ["obsolete"])));
  expect(document.body.textContent).not.toContain("obsolete");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
});
it("opens the keyboard-selected file after closing the dialog", async () => {
  mocks.api.mockResolvedValueOnce(response("rev", ["first", "second"]));
  const file = {
    path: "sql/second.sql",
    content: "select 1",
    name: "second.sql",
    revision: "v1",
  };
  mocks.api.mockResolvedValueOnce(file);
  await open();
  await type("rev");
  await tick();
  await key("ArrowDown");
  await key("Enter");
  await tick(50);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onOpenFile).toHaveBeenCalledWith(
    file,
    expect.objectContaining({
      requestId: expect.any(String),
      target: expect.objectContaining({ path: "sql/second.sql" }),
    }),
  );
});
it("opens globally before editor propagation stops, ignores other modals, and returns focus", async () => {
  const editor = document.createElement("textarea");
  host.append(editor);
  editor.addEventListener("keydown", (event) => event.stopPropagation());
  editor.focus();
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyK",
        key: "л",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.activeElement).toBe(input());
  await key("Escape");
  await tick(50);
  expect(document.activeElement).toBe(editor);
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyK",
        key: "k",
        metaKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(input()).toBeNull();
  modal.remove();
});
it("distinguishes failed searches and partial empty results", async () => {
  mocks.api.mockRejectedValueOnce(new Error("Поиск недоступен"));
  await open();
  await type("first");
  await tick();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Поиск недоступен",
  );
  mocks.api.mockResolvedValueOnce({
    query: "second",
    groups: [],
    incomplete: true,
  });
  await type("second");
  await tick();
  expect(document.body.textContent).toContain(
    "Не все документы удалось проверить",
  );
  expect(document.body.textContent).not.toContain("Ничего не найдено");
});

it("keeps search open when a SQL file exceeds the editor limit", async () => {
  mocks.api.mockResolvedValueOnce(response("big", ["big"]));
  mocks.api.mockResolvedValueOnce({
    path: "sql/big.sql",
    name: "big.sql",
    content: "x".repeat(1_000_001),
    revision: "v1",
  });
  await open();
  await type("big");
  await tick();
  await key("Enter");
  await tick(50);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "1 000 000",
  );
  expect(onOpenFile).not.toHaveBeenCalled();
});

const tabs = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];
const selectedTab = () =>
  document.querySelector<HTMLButtonElement>(
    '[role="tab"][aria-selected="true"]',
  )!;
const tab = (name: string) =>
  tabs().find((element) => element.textContent?.startsWith(name))!;
const options = () => [...document.querySelectorAll('[role="option"]')];

it("ranks All across document types and still filters to the selected type", async () => {
  mocks.api.mockResolvedValueOnce({
    query: "выручка год",
    incomplete: false,
    groups: [
      {
        type: "boards",
        total: 1,
        items: [
          {
            key: "monthly-board",
            title: "Выручка за месяц",
            subtitle: "Доска",
            group: "boards",
            relevance: 102,
            target: { kind: "board", id: "monthly-board", revision: 1 },
          },
        ],
      },
      {
        type: "sql",
        total: 1,
        items: [{ ...item("Выручка за год"), relevance: 205 }],
      },
    ],
  } satisfies SearchResponse);
  await open();
  await type("выручка год");
  await tick();

  expect(selectedTab()).toBe(tab("Все"));
  expect(
    options().map((element) => element.querySelector("strong")?.textContent),
  ).toEqual(["Выручка за год", "Выручка за месяц"]);
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("Выручка за год");

  await act(async () => tab("Доски").click());
  expect(options()).toHaveLength(1);
  expect(options()[0].textContent).toContain("Выручка за месяц");
  expect(mocks.api).toHaveBeenCalledTimes(1);

  const file = {
    path: "sql/Выручка за год.sql",
    content: "select 1",
    name: "Выручка за год.sql",
    revision: "v1",
  };
  mocks.api.mockResolvedValueOnce(file);
  await act(async () => tab("Все").click());
  await key("Enter");
  await tick(50);
  expect(onOpenFile).toHaveBeenCalledWith(
    file,
    expect.objectContaining({
      target: expect.objectContaining({ path: "sql/Выручка за год.sql" }),
    }),
  );
  expect(mocks.openCanvas).not.toHaveBeenCalled();
});

it("offers only found types after All, filters locally, and resets the type for a new search", async () => {
  mocks.api.mockResolvedValueOnce(groupedResponse("rev"));
  await open();
  await type("rev");
  await tick();
  expect(document.querySelector('[role="tablist"]')).not.toBeNull();
  expect(
    tabs().map((element) => element.textContent?.replace(/\d+/g, "").trim()),
  ).toEqual(["Все", "Доски", "SQL", "Markdown"]);
  expect(selectedTab()).toBe(tab("Все"));
  expect(tab("Все").textContent).toContain("26");
  expect(tab("SQL").textContent).toContain("24");
  expect(options()).toHaveLength(4);

  await act(async () => tab("SQL").click());
  expect(selectedTab()).toBe(tab("SQL"));
  expect(
    options().map((element) => element.querySelector("strong")?.textContent),
  ).toEqual(["first", "second"]);
  expect(document.body.textContent).toMatch(/показано 2 из 24/i);
  await key("ArrowDown");
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("second");
  expect(mocks.api).toHaveBeenCalledTimes(1);

  mocks.api.mockResolvedValueOnce(
    response("next", ["next-first", "next-second"]),
  );
  await type("next");
  await tick();
  expect(selectedTab()).toBe(tab("Все"));
  expect(tabs()).toHaveLength(2);
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("next-first");
  expect(mocks.api).toHaveBeenCalledTimes(2);
});

it("cycles types from the input and opens only the keyboard-selected result in that type", async () => {
  mocks.api.mockResolvedValueOnce(groupedResponse("rev"));
  const file = {
    path: "sql/second.sql",
    content: "select 1",
    name: "second.sql",
    revision: "v1",
  };
  mocks.api.mockResolvedValueOnce(file);
  await open();
  await type("rev");
  await tick();
  for (const modifier of ["metaKey", "ctrlKey", "shiftKey"] as const) {
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
      [modifier]: true,
    });
    await act(async () => input().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(selectedTab()).toBe(tab("Все"));
  }
  await key("ArrowLeft");
  expect(selectedTab()).toBe(tab("Markdown"));
  expect(options()).toHaveLength(1);
  expect(document.activeElement).toBe(input());
  await key("ArrowRight");
  expect(selectedTab()).toBe(tab("Все"));
  await key("ArrowRight");
  expect(selectedTab()).toBe(tab("Доски"));
  await key("ArrowRight");
  expect(selectedTab()).toBe(tab("SQL"));
  await key("ArrowDown");
  await key("ArrowUp");
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("first");
  await key("ArrowDown");
  expect(document.activeElement).toBe(input());
  expect(mocks.api).toHaveBeenCalledTimes(1);
  await key("Enter");
  await tick(50);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onOpenFile).toHaveBeenCalledWith(
    file,
    expect.objectContaining({
      target: expect.objectContaining({ path: "sql/second.sql" }),
    }),
  );
  expect(mocks.openCanvas).not.toHaveBeenCalled();
});

it("moves tab focus with horizontal arrows and keeps a single tab stop", async () => {
  mocks.api.mockResolvedValueOnce(groupedResponse("rev"));
  await open();
  await type("rev");
  await tick();
  const pressTab = async (key: string) => {
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  };
  await act(async () => tab("Все").focus());
  await pressTab("ArrowRight");
  expect(document.activeElement).toBe(tab("Доски"));
  expect(selectedTab()).toBe(tab("Доски"));
  await pressTab("ArrowLeft");
  expect(document.activeElement).toBe(tab("Все"));
  await pressTab("ArrowLeft");
  expect(document.activeElement).toBe(tab("Markdown"));
  expect(selectedTab()).toBe(tab("Markdown"));
  expect(tabs().filter((element) => element.tabIndex === 0)).toEqual([
    tab("Markdown"),
  ]);
  expect(options()).toHaveLength(1);
  expect(mocks.api).toHaveBeenCalledTimes(1);
});
