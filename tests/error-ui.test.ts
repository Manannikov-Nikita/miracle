// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBox, Toasts } from "../src/client/components/UI";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("error explanation and full diagnostics", () => {
  it("shows a specific cause and correction with complete collapsed diagnostics", async () => {
    const details =
      "ClickHouse HTTP 401: AUTHENTICATION_FAILED\n" +
      "diagnostic line\n".repeat(300);
    await act(async () =>
      root.render(
        createElement(ErrorBox, {
          error: {
            message: "Connection rejected",
            code: "CONNECTION_AUTH",
            details,
          },
          context: "connection",
        }),
      ),
    );
    expect(host.textContent).toContain(
      "Сервер не принял имя пользователя или пароль.",
    );
    expect(host.textContent).toContain("Проверьте имя пользователя и пароль");
    const disclosure = host.querySelector("details")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")!.textContent).toBe(
      "Полный текст ошибки",
    );
    expect(disclosure.querySelector("pre")!.textContent).toContain(details);
    await act(async () => disclosure.querySelector("summary")!.click());
    expect(disclosure.open).toBe(true);
    await act(async () =>
      root.render(createElement(ErrorBox, { error: "ENOTFOUND" })),
    );
    expect(host.querySelector("details")!.open).toBe(false);
  });

  it("retains operation-specific actions without re-running them on disclosure", async () => {
    const retry = vi.fn();
    await act(async () =>
      root.render(
        createElement(ErrorBox, {
          children: "getaddrinfo ENOTFOUND warehouse.test",
          title: "Не удалось загрузить таблицу.",
          actions: createElement("button", { onClick: retry }, "Повторить"),
        }),
      ),
    );
    expect(host.textContent).toContain("Не удалось загрузить таблицу.");
    await act(async () => host.querySelector("summary")!.click());
    expect(retry).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps error details readable when the originating toast expires", async () => {
    const message = "DB::Exception: SYNTAX_ERROR at position 42\nSELECT (";
    await act(async () =>
      root.render(
        createElement(Toasts, {
          items: [{ id: 1, message, tone: "error" }],
          onDismiss: vi.fn(),
        }),
      ),
    );
    expect(host.textContent).toContain("Ошибка в синтаксисе SQL.");
    expect(host.textContent).not.toContain("position 42");
    const more = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Подробнее",
    )!;
    await act(async () => more.click());
    expect(document.querySelector('[role="dialog"] pre')!.textContent).toBe(
      message,
    );
    await act(async () =>
      root.render(createElement(Toasts, { items: [], onDismiss: vi.fn() })),
    );
    expect(document.querySelector('[role="dialog"] pre')!.textContent).toBe(
      message,
    );
    await act(async () =>
      (
        document.querySelector(
          '[role="dialog"] [aria-label="Закрыть"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
