// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import Connections from "../src/client/components/Connections";
import type { Connection } from "../src/shared/types";

const saved: Connection = {
  id: "warehouse",
  name: "Warehouse",
  engine: "trino",
  url: "https://warehouse.test:8443",
  username: "reader",
  hasPassword: true,
  trino: { externalAuthentication: true, tls: { hasCaCert: true } },
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
const pending = {
  id: "login-session",
  status: "pending",
  redirectUrl: "https://identity.test/login",
};

describe("connection credentials and browser login", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  const changed = vi.fn();

  async function render(open = true) {
    await act(async () =>
      root.render(
        createElement(Connections, {
          open,
          connections: [saved],
          onClose() {},
          onChanged: changed,
          onNotify() {},
        }),
      ),
    );
  }
  async function click(label: string) {
    const target = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        (button.classList.contains("engine-option")
          ? button.textContent?.includes(label)
          : button.textContent?.trim() === label),
    );
    expect(target, label).toBeDefined();
    await act(async () => target!.click());
  }
  async function input(selector: string, value: string) {
    const target = document.querySelector<HTMLInputElement>(selector);
    expect(target, selector).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(target, value);
      target!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const requests = (path: string, method: string) =>
    fetchMock.mock.calls.filter(
      ([url, options]) => url === path && options?.method === method,
    );

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/connections/auth/start") return response(pending);
      if (path.endsWith("/poll")) return response({ status: "pending" });
      return response({ ok: true, version: "478" });
    });
    vi.stubGlobal("fetch", fetchMock);
    changed.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render();
    await click("Настроить Warehouse");
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reveals only the entered password and hides it again when reopening", async () => {
    const password = document.querySelector<HTMLInputElement>(
      'input[autocomplete="new-password"]',
    )!;
    expect(password.value).toBe("");
    await input('input[autocomplete="new-password"]', "typed-secret");
    await click("Показать пароль");
    expect(password.type).toBe("text");
    expect(password.value).toBe("typed-secret");
    expect(
      document
        .querySelector('[aria-label="Скрыть пароль"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await click("Скрыть пароль");
    expect(password.type).toBe("password");
    await click("Показать пароль");
    await click("Назад");
    await click("Настроить Warehouse");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[autocomplete="new-password"]',
      )?.type,
    ).toBe("password");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[autocomplete="new-password"]',
      )?.value,
    ).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports JDBC fields and browser authentication while retaining the saved CA", async () => {
    await input(
      '[aria-label="JDBC URL Trino"]',
      "jdbc:trino://gateway.test:8443/hive/analytics?SSL=true&SSLVerification=FULL&externalAuthentication=true&externalAuthenticationTokenCache=MEMORY&user=analyst",
    );
    await click("Импортировать JDBC URL");
    expect(
      document.querySelector<HTMLInputElement>('input[type="url"]')?.value,
    ).toBe("https://gateway.test:8443");
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Вход через браузер"]',
      )?.checked,
    ).toBe(true);
    await click("Проверить");
    const body = JSON.parse(
      requests("/api/connections/test", "POST")[0][1].body,
    );
    expect(body).toMatchObject({
      username: "analyst",
      catalog: "hive",
      schema: "analytics",
      trino: { externalAuthentication: true },
    });
    expect(JSON.stringify(body)).not.toContain("hasCaCert");
    expect(JSON.stringify(body)).not.toContain("caCert");
  });

  it("keeps invalid JDBC settings visible without changing the connection", async () => {
    await input(
      '[aria-label="JDBC URL Trino"]',
      "jdbc:trino://gateway.test?SSL=true&SSLVerification=NONE",
    );
    await click("Импортировать JDBC URL");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLInputElement>('input[type="url"]')?.value,
    ).toBe(saved.url);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a browser link, polls, and reuses the login in test and save", async () => {
    await click("Войти через браузер");
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="https://identity.test/login"]',
    );
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(document.body.textContent).toContain("Ожидаем вход в браузере");
    fetchMock.mockImplementation(async (path: string) =>
      response(
        path.endsWith("/poll")
          ? { status: "authenticated" }
          : { ok: true, version: "478" },
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(document.body.textContent).toContain("Вход выполнен");
    await click("Проверить");
    const checked = JSON.parse(
      requests("/api/connections/test", "POST")[0][1].body,
    );
    expect(checked).toMatchObject({
      id: "warehouse",
      authSessionId: "login-session",
      trino: { externalAuthentication: true },
    });
    expect(checked.password).toBeUndefined();
    await click("Сохранить");
    const patch = JSON.parse(
      requests("/api/connections/warehouse", "PATCH")[0][1].body,
    );
    expect(patch.authSessionId).toBe("login-session");
    expect(changed).toHaveBeenCalledWith("warehouse");
  });

  it("cancels pending login when fields change and ignores its late poll", async () => {
    let finishPoll!: (value: Response) => void;
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/connections/auth/start") return response(pending);
      if (path.endsWith("/poll"))
        return new Promise<Response>((resolve) => {
          finishPoll = resolve;
        });
      return response({ ok: true });
    });
    await click("Войти через браузер");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await input('input[type="url"]', "https://changed.test");
    expect(
      requests("/api/connections/auth/login-session", "DELETE"),
    ).toHaveLength(1);
    await act(async () => finishPoll(response({ status: "authenticated" })));
    expect(document.body.textContent).not.toContain("Вход выполнен");
    await click("Проверить");
    const body = JSON.parse(
      requests("/api/connections/test", "POST")[0][1].body,
    );
    expect(body.authSessionId).toBeUndefined();
  });

  it("cancels a late start response after the dialog closes", async () => {
    let finishStart!: (value: Response) => void;
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/connections/auth/start")
        return new Promise<Response>((resolve) => {
          finishStart = resolve;
        });
      return response({ ok: true });
    });
    await click("Войти через браузер");
    await render(false);
    await act(async () => finishStart(response(pending)));
    expect(
      requests("/api/connections/auth/login-session", "DELETE"),
    ).toHaveLength(1);
    expect(
      requests("/api/connections/auth/login-session/poll", "POST"),
    ).toHaveLength(0);
    await render();
    await click("Настроить Warehouse");
    expect(document.body.textContent).not.toContain("Ожидаем вход в браузере");
  });

  it("cancels explicitly and permits a new login", async () => {
    await click("Войти через браузер");
    await click("Отменить вход");
    expect(
      requests("/api/connections/auth/login-session", "DELETE"),
    ).toHaveLength(1);
    await click("Войти через браузер");
    expect(requests("/api/connections/auth/start", "POST")).toHaveLength(2);
  });

  it("allows the external identity provider to supply an empty username", async () => {
    await input('input[placeholder="readonly"]', "");
    expect(
      document.querySelector<HTMLFormElement>("form")?.checkValidity(),
    ).toBe(true);
    await click("Войти через браузер");
    const body = JSON.parse(
      requests("/api/connections/auth/start", "POST")[0][1].body,
    );
    expect(body.username).toBe("");
    await click("Отменить вход");
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('[aria-label="Вход через браузер"]')!
        .click(),
    );
    expect(
      document.querySelector<HTMLFormElement>("form")?.checkValidity(),
    ).toBe(false);
  });

  it("accepts a cached login without a redirect or polling and invalidates it on edits", async () => {
    fetchMock.mockImplementation(async () =>
      response({
        id: "cached-session",
        status: "authenticated",
      }),
    );
    await click("Войти через браузер");
    expect(document.body.textContent).toContain("Вход выполнен");
    expect(document.querySelector('a[target="_blank"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(
      requests("/api/connections/auth/cached-session/poll", "POST"),
    ).toHaveLength(0);
    await input('input[placeholder="readonly"]', "other-reader");
    expect(document.body.textContent).not.toContain("Вход выполнен");
    expect(
      requests("/api/connections/auth/cached-session", "DELETE"),
    ).toHaveLength(1);
  });

  it("shows expiry during polling and allows a fresh browser login", async () => {
    await click("Войти через браузер");
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            error: "Время входа истекло",
            code: "TRINO_AUTH_EXPIRED",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Ожидаем вход в браузере");
    await click("Войти через браузер");
    expect(requests("/api/connections/auth/start", "POST")).toHaveLength(2);
  });

  it("passes a completed draft login into connection creation", async () => {
    await click("Назад");
    await click("Новое подключение");
    await click("Trino");
    await input('input[maxlength="120"]', "New warehouse");
    await input('input[type="url"]', "https://new.test");
    await input('input[placeholder="readonly"]', "reader");
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('[aria-label="Вход через браузер"]')!
        .click(),
    );
    fetchMock.mockImplementation(async (path: string) =>
      response(
        path === "/api/connections/auth/start"
          ? { id: "draft-session", status: "authenticated" }
          : { id: "new-warehouse" },
      ),
    );
    await click("Войти через браузер");
    await click("Сохранить");
    const body = JSON.parse(requests("/api/connections", "POST")[0][1].body);
    expect(body).toMatchObject({
      name: "New warehouse",
      authSessionId: "draft-session",
      trino: { externalAuthentication: true },
    });
    expect(body.id).toBeUndefined();
  });
});
