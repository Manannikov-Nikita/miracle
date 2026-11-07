// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import AgentSqlPreview from "../src/client/agents/AgentSqlPreview";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const openButton = () =>
  host.querySelector<HTMLButtonElement>(
    'button[aria-label="Открыть в редакторе"]',
  )!;

it("highlights SQL with multiline lexer state and preserves every character as text", async () => {
  const sql =
    "SELECT 42, '<img src=x onerror=alert(1)>'\r\n/* first\r\nSELECT */\nFROM events ARRAY JOIN tags\r\n";
  await act(async () => root.render(createElement(AgentSqlPreview, { sql })));
  expect(host.querySelector("code")?.textContent).toBe(sql);
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector(".agent-sql-token-keyword")?.textContent).toBe(
    "SELECT",
  );
  expect(host.querySelector(".agent-sql-token-number")?.textContent).toBe("42");
  expect(
    [...host.querySelectorAll(".agent-sql-token-comment")]
      .map((token) => token.textContent)
      .join(""),
  ).toBe("/* firstSELECT */");
  expect(openButton()).toBeNull();
});

it("opens once while pending and reports completion only after opening succeeds", async () => {
  let complete!: () => void;
  const onOpen = vi.fn(
    () => new Promise<void>((resolve) => (complete = resolve)),
  );
  const onOpened = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await act(async () =>
    root.render(
      createElement(AgentSqlPreview, { sql: "SELECT 1", onOpen, onOpened }),
    ),
  );
  expect(openButton().title).toBe("Открыть в редакторе");
  await act(async () => {
    openButton().click();
    openButton().click();
  });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpened).not.toHaveBeenCalled();
  expect(openButton().disabled).toBe(true);
  expect(openButton().getAttribute("aria-busy")).toBe("true");
  await act(async () => complete());
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(openButton().disabled).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it("shows an opening error and lets the same control retry", async () => {
  const onOpen = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Запрос больше не доступен"))
    .mockResolvedValueOnce();
  const onOpened = vi.fn();
  await act(async () =>
    root.render(
      createElement(AgentSqlPreview, { sql: "SELECT 1", onOpen, onOpened }),
    ),
  );
  await act(async () => openButton().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Запрос больше не доступен",
  );
  expect(openButton().disabled).toBe(false);
  expect(onOpened).not.toHaveBeenCalled();
  await act(async () => openButton().click());
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("does not dismiss another view after an unmounted preview finishes opening", async () => {
  let complete!: () => void;
  const onOpen = () => new Promise<void>((resolve) => (complete = resolve));
  const onOpened = vi.fn();
  await act(async () =>
    root.render(
      createElement(AgentSqlPreview, { sql: "SELECT 1", onOpen, onOpened }),
    ),
  );
  await act(async () => openButton().click());
  await act(async () => root.render(null));
  await act(async () => complete());
  expect(onOpened).not.toHaveBeenCalled();
});
