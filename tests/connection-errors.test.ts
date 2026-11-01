// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import Connections from "../src/client/components/Connections";
import type { Connection } from "../src/shared/types";

const saved: Connection = {
  id: "warehouse",
  name: "Warehouse",
  engine: "clickhouse",
  url: "https://warehouse.test:8443",
  username: "reader",
  hasPassword: true,
};
const diagnostics =
  "getaddrinfo ENOTFOUND warehouse.test\n" + "Diagnostic line\n".repeat(300);
const failure = (error = "Не удалось подключиться", details = diagnostics) =>
  new Response(JSON.stringify({ error, details }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
const success = () =>
  new Response(JSON.stringify({ ok: true, version: "25.1" }), {
    headers: { "Content-Type": "application/json" },
  });

describe("connection error presentation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  const changed = vi.fn();
  const notify = vi.fn();
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetchMock = vi.fn(async () => failure());
    vi.stubGlobal("fetch", fetchMock);
    changed.mockClear();
    notify.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(Connections, {
          open: true,
          onClose: vi.fn(),
          connections: [saved],
          onChanged: changed,
          onNotify: notify,
        }),
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function click(selector: string) {
    await act(async () =>
      document.querySelector<HTMLElement>(selector)!.click(),
    );
  }
  async function clickText(text: string) {
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === text)!
        .click(),
    );
  }
  async function input(selector: string, value: string) {
    await act(async () => {
      const field = document.querySelector<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("keeps complete draft-test diagnostics and form values, then hides a stale error after editing", async () => {
    await click('[aria-label="Настроить Warehouse"]');
    await input('input[type="password"]', "entered-password");
    await clickText("Проверить");
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Не удалось найти сервер базы данных.");
    expect(alert.querySelector("summary")?.textContent).toBe(
      "Полный текст ошибки",
    );
    expect(alert.querySelector("pre")?.textContent).toContain(diagnostics);
    expect(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.value,
    ).toBe("entered-password");
    expect(
      document.querySelector<HTMLInputElement>('input[type="url"]')?.value,
    ).toBe(saved.url);
    expect(changed).not.toHaveBeenCalled();
    await input('input[type="url"]', "https://corrected.test:8443");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows saved-connection test failures with details and replaces them with a successful status", async () => {
    await click('[aria-label="Проверить Warehouse"]');
    const item = document.querySelector(".connection-item")!;
    expect(item.querySelector('[role="alert"] pre')?.textContent).toContain(
      diagnostics,
    );
    expect(item.querySelector('[role="status"]')).toBeNull();
    fetchMock.mockImplementationOnce(async () => success());
    await click('[aria-label="Проверить Warehouse"]');
    expect(item.querySelector('[role="alert"]')).toBeNull();
    expect(item.querySelector('[role="status"]')?.textContent).toBe(
      "Доступно · 25.1",
    );
  });

  it("explains save failure in place without losing credentials, and clears it when the form changes", async () => {
    fetchMock.mockImplementation(async () =>
      failure("Storage write failed", "The project database is busy"),
    );
    await click('[aria-label="Настроить Warehouse"]');
    await input('input[type="password"]', "keep-this-password");
    await clickText("Сохранить");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Не удалось сохранить подключение.",
    );
    expect(document.querySelector('[role="alert"] pre')?.textContent).toContain(
      "The project database is busy",
    );
    expect(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.value,
    ).toBe("keep-this-password");
    expect(changed).not.toHaveBeenCalled();
    await input('input[type="url"]', "https://corrected.test:8443");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps deletion errors in the confirmation and allows a successful retry", async () => {
    fetchMock.mockImplementation(async () =>
      failure("Delete failed", "The connection is still referenced"),
    );
    await click('[aria-label="Удалить Warehouse"]');
    await clickText("Удалить");
    const confirmation = [...document.querySelectorAll('[role="dialog"]')].find(
      (dialog) => dialog.textContent?.includes("Удалить подключение?"),
    )!;
    expect(confirmation.querySelector('[role="alert"]')?.textContent).toContain(
      "Не удалось удалить подключение.",
    );
    expect(
      confirmation.querySelector('[role="alert"] pre')?.textContent,
    ).toContain("The connection is still referenced");
    expect(changed).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(async () => success());
    await clickText("Удалить");
    expect(document.body.textContent).not.toContain("Удалить подключение?");
    expect(changed).toHaveBeenCalledWith("warehouse");
  });
});
