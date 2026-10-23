// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import Setup from "../src/client/components/Setup";
import App from "../src/client/App";
import {
  consumeSetupToken,
  isLocalInstallation,
} from "../src/client/local-installation";
import { api, setCsrfToken } from "../src/client/api";

vi.mock("../src/client/components/SqlWorkspace", () => ({
  default: () => createElement("div", null, "Empty SQL workspace"),
}));
vi.mock("../src/client/board/BoardWorkspace", () => ({
  default: () => createElement("div", null, "Empty board"),
}));
vi.mock("../src/client/components/Explorer", () => ({ default: () => null }));

const user = {
  id: "first-admin",
  name: "Ada",
  email: "ada@example.test",
  role: "admin" as const,
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("local first-run setup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetcher: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
      removeItem: (key: string) => stored.delete(key),
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
      setTimeout(callback, 0),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    setCsrfToken("");
    history.replaceState({}, "", "/");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });
  async function fill(label: string, value: string) {
    const field = [...container.querySelectorAll("label")]
      .find((node) => node.textContent?.startsWith(label))!
      .querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await fill("Ваше имя", "Ada");
    await fill("Email", "ada@example.test");
    await fill("Пароль", "a strong setup password");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  }

  it("immediately removes setup credentials while preserving invitation and other URL state", () => {
    history.replaceState(
      {},
      "",
      "/?token=existing-invite#setup=private-setup-token&panel=sql",
    );
    expect(consumeSetupToken()).toBe("private-setup-token");
    expect(location.search).toBe("?token=existing-invite");
    expect(location.hash).toBe("#panel=sql");
    expect(consumeSetupToken()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("completes setup once, passes credentials only in the POST body, and installs the session CSRF token", async () => {
    const complete = vi.fn();
    fetcher.mockResolvedValueOnce(
      response({ user, csrfToken: "session-csrf" }),
    );
    await act(async () =>
      root.render(
        createElement(Setup, {
          token: "private-token",
          onComplete: complete,
          onInitialized: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).not.toContain("private-token");
    expect(
      container
        .querySelector('input[autocomplete="new-password"]')
        ?.getAttribute("minlength"),
    ).toBe("12");
    await submit();
    expect(complete).toHaveBeenCalledWith(user);
    expect(fetcher.mock.calls[0][0]).toBe("/api/setup/complete");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      token: "private-token",
      name: "Ada",
      email: "ada@example.test",
      password: "a strong setup password",
    });
    fetcher.mockResolvedValueOnce(response({}));
    await api("/api/test", { method: "POST" });
    expect(fetcher.mock.calls[1][1].headers.get("X-CSRF-Token")).toBe(
      "session-csrf",
    );
  });

  it.each([401, 403, 410])(
    "shows replacement-link guidance for an expired or reused link (%s)",
    async (status) => {
      const unauthorized = vi.fn();
      window.addEventListener("miracle:unauthorized", unauthorized);
      fetcher
        .mockResolvedValueOnce(response({ error: "invalid token" }, status))
        .mockResolvedValueOnce(response({ required: true }));
      const complete = vi.fn();
      await act(async () =>
        root.render(
          createElement(Setup, {
            token: "expired",
            onComplete: complete,
            onInitialized: vi.fn(),
          }),
        ),
      );
      await submit();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Ссылка истекла или уже использована",
      );
      expect(container.textContent).toContain("start.cmd");
      expect(container.textContent).toContain("sh start.sh");
      expect(container.querySelector("form")).toBeNull();
      expect(complete).not.toHaveBeenCalled();
      expect(unauthorized).not.toHaveBeenCalled();
      window.removeEventListener("miracle:unauthorized", unauthorized);
    },
  );

  it("falls back to login when another browser has initialized the installation", async () => {
    fetcher.mockImplementation(async (path: string) => {
      if (path === "/api/setup/status")
        return response({
          required:
            fetcher.mock.calls.filter(([url]) => url === path).length === 1,
        });
      if (path === "/api/setup/complete")
        return response({ error: "Already initialized" }, 409);
      if (path === "/api/auth/me")
        return response({ user: null, csrfToken: "login-csrf" });
      throw new Error(`Unexpected endpoint ${path}`);
    });
    await act(async () =>
      root.render(createElement(App, { setupToken: "used-token" })),
    );
    await submit();
    expect(container.textContent).toContain("Продолжим исследование");
    expect(container.textContent).not.toContain("Создать рабочую область");
  });

  it("shows launch instructions for an uninitialized installation without a token", async () => {
    fetcher.mockResolvedValue(response({ required: true }));
    await act(async () => root.render(createElement(App)));
    expect(container.textContent).toContain("Нужна ссылка запуска");
    expect(container.textContent).toContain("30 минут");
    expect(container.querySelector("form")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("opens the workspace after setup without creating demo sources or queries", async () => {
    fetcher.mockImplementation(async (path: string) => {
      if (path === "/api/setup/status") return response({ required: true });
      if (path === "/api/setup/complete")
        return response({ user, csrfToken: "setup-csrf" });
      if (path === "/api/connections") return response([]);
      throw new Error(`Unexpected endpoint ${path}`);
    });
    await act(async () =>
      root.render(createElement(App, { setupToken: "valid-token" })),
    );
    await submit();
    expect(container.textContent).toContain("Empty SQL workspace");
    expect(container.textContent).toContain("Empty board");
    expect(
      fetcher.mock.calls
        .filter(([, options]) => options.method === "POST")
        .map(([path]) => path),
    ).toEqual(["/api/setup/complete"]);
  });

  it("keeps existing team activation reachable on an initialized installation", async () => {
    history.replaceState({}, "", "/?token=team-invitation");
    fetcher.mockImplementation(async (path: string) =>
      path === "/api/setup/status"
        ? response({ required: false })
        : response({ user: null, csrfToken: "auth-csrf" }),
    );
    await act(async () =>
      root.render(createElement(App, { setupToken: "old-setup-token" })),
    );
    expect(container.textContent).toContain(
      "Задайте пароль для входа в команду",
    );
    expect(container.textContent).toContain("Создать пароль");
    expect(location.search).toBe("?token=team-invitation");
  });

  it("preserves the setup form after validation errors and permits correction", async () => {
    fetcher
      .mockResolvedValueOnce(response({ error: "Email invalid" }, 400))
      .mockResolvedValueOnce(response({ required: true }));
    await act(async () =>
      root.render(
        createElement(Setup, {
          token: "valid",
          onComplete: vi.fn(),
          onInitialized: vi.fn(),
        }),
      ),
    );
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Email invalid",
    );
    expect(container.querySelector("form")).not.toBeNull();
    expect(
      container
        .querySelector('button[type="submit"], .auth-submit')
        ?.hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("local installation hints", () => {
  it.each([
    "localhost",
    "work.localhost",
    "127.0.0.1",
    "127.2.3.4",
    "[::1]",
    "::1",
  ])("recognizes loopback %s", (host) =>
    expect(isLocalInstallation(host)).toBe(true),
  );
  it.each([
    "miracle.company.ru",
    "192.168.1.2",
    "localhost.example.com",
    "example.com",
  ])("avoids local-only warnings for %s", (host) =>
    expect(isLocalInstallation(host)).toBe(false),
  );
});
