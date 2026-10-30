// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
let App: typeof import("../src/client/App").default;
let api: typeof import("../src/client/api").api;

// Canvas and Monaco need a browser layout/worker engine; exercise the real shell,
// explorer, connection form and API boundary here, and SQL persistence separately.
vi.mock("../src/client/components/SqlWorkspace", () => ({
  default: () => null,
}));
vi.mock("../src/client/board/BoardWorkspace", () => ({ default: () => null }));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("personal local workspace", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let fetcher: ReturnType<typeof vi.fn>;
  let calls: string[];
  let expired: boolean;
  let writes: number;
  let handshakeCount: number;
  // Cold CI transforms can exceed the normal hook budget. Keep this allowance
  // limited to module loading; fixture setup and test assertions retain theirs.
  beforeEach(async function loadWorkspaceModules() {
    vi.resetModules();
    ({ default: App } = await import("../src/client/App"));
    ({ api } = await import("../src/client/api"));
  }, 60_000);
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
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
    calls = [];
    expired = false;
    writes = 0;
    handshakeCount = 0;
    fetcher = vi.fn(async (path: string, options: RequestInit = {}) => {
      calls.push(path);
      if (path === "/api/session") {
        expired = false;
        handshakeCount++;
        return response({
          workspaceId: "personal-workspace",
          csrfToken: `csrf-${handshakeCount}`,
        });
      }
      if (expired)
        return response(
          { error: "Session expired", code: "UNAUTHORIZED" },
          401,
        );
      if (options.method === "POST") {
        if (
          new Headers(options.headers).get("X-CSRF-Token") !==
          `csrf-${handshakeCount}`
        )
          return response({ error: "Wrong CSRF" }, 403);
        writes++;
        return response({ id: "new-connection" });
      }
      if (path === "/api/connections" || path === "/api/queries")
        return response([]);
      throw new Error(`Unexpected endpoint ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    const mountedRoot = root;
    root = undefined;
    try {
      if (mountedRoot) await act(async () => mountedRoot.unmount());
    } finally {
      container?.remove();
      vi.unstubAllGlobals();
    }
  });
  async function open() {
    await act(async () => root!.render(createElement(App)));
  }
  async function click(selector: string) {
    await act(async () =>
      (document.querySelector(selector) as HTMLButtonElement).click(),
    );
  }

  it("opens the empty workspace directly with personal editing controls and no account UI", async () => {
    await open();
    expect(
      container.querySelector('nav[aria-label="Рабочая область"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Подключения"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Управление командой"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Меню пользователя"]'),
    ).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(calls[0]).toBe("/api/session");
    expect(calls.some((path) => /\/api\/(auth|setup|users)/.test(path))).toBe(
      false,
    );
    expect(writes).toBe(0);
    await click('[aria-label="Подключения"]');
    expect(document.body.textContent).toContain("Добавить подключение");
  });

  it("recovers an expired local session and performs the rejected write exactly once", async () => {
    await open();
    expired = true;
    const saved = await api<{ id: string }>("/api/connections", {
      method: "POST",
      body: JSON.stringify({ name: "Warehouse" }),
    });
    expect(saved.id).toBe("new-connection");
    expect(writes).toBe(1);
    expect(handshakeCount).toBe(2);
    expect(
      container.querySelector('nav[aria-label="Рабочая область"]'),
    ).not.toBeNull();
    expect(
      localStorage.getItem("miracle:view:personal-workspace"),
    ).not.toBeNull();
  });

  it("shares one session refresh between simultaneous expired requests", async () => {
    await open();
    expired = true;
    await Promise.all([api("/api/connections"), api("/api/queries")]);
    expect(handshakeCount).toBe(2);
  });

  it("stops after one handshake when the server keeps rejecting the session", async () => {
    fetcher.mockImplementation(async (path: string) =>
      path === "/api/session"
        ? response({ workspaceId: "personal-workspace", csrfToken: "csrf" })
        : response({ error: "Session unavailable" }, 401),
    );
    await expect(
      api("/api/connections", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/connections",
      "/api/session",
      "/api/connections",
    ]);
  });

  it("renews a dormant tab's stale CSRF after another tab replaces the shared cookie and executes its write once", async () => {
    await open();
    const attempts: string[] = [];
    let saved = 0;
    fetcher.mockImplementation(
      async (path: string, options: RequestInit = {}) => {
        attempts.push(path);
        if (path === "/api/session")
          return response({
            workspaceId: "personal-workspace",
            csrfToken: "renewed-shared-csrf",
          });
        if (
          new Headers(options.headers).get("X-CSRF-Token") !==
          "renewed-shared-csrf"
        )
          return response(
            { error: "Local session stale", code: "LOCAL_SESSION_STALE" },
            403,
          );
        saved++;
        return response({ id: "saved-query" });
      },
    );
    const result = await api<{ id: string }>("/api/queries", {
      method: "POST",
      body: JSON.stringify({ name: "My query" }),
    });
    expect(result.id).toBe("saved-query");
    expect(saved).toBe(1);
    expect(attempts).toEqual(["/api/queries", "/api/session", "/api/queries"]);
  });

  it("stops after one refresh if the explicit stale-session code keeps returning", async () => {
    await open();
    const attempts: string[] = [];
    fetcher.mockImplementation(async (path: string) => {
      attempts.push(path);
      return path === "/api/session"
        ? response({
            workspaceId: "personal-workspace",
            csrfToken: "fresh-csrf",
          })
        : response({ error: "Still stale", code: "LOCAL_SESSION_STALE" }, 403);
    });
    await expect(
      api("/api/queries", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ status: 403, code: "LOCAL_SESSION_STALE" });
    expect(attempts).toEqual(["/api/queries", "/api/session", "/api/queries"]);
  });

  it("does not replay a write after an ambiguous network failure", async () => {
    await open();
    fetcher.mockImplementationOnce(async () => {
      writes++;
      throw new TypeError("Failed to fetch");
    });
    await expect(
      api("/api/connections", { method: "POST", body: "{}" }),
    ).rejects.toThrow("Failed to fetch");
    expect(writes).toBe(1);
    expect(handshakeCount).toBe(1);
  });

  it("leaves CSRF and revision rejections visible without refreshing or replaying", async () => {
    await open();
    for (const status of [403, 409]) {
      fetcher.mockImplementationOnce(async () =>
        response({ error: "Rejected" }, status),
      );
      await expect(
        api("/api/connections", { method: "POST", body: "{}" }),
      ).rejects.toMatchObject({ status });
    }
    expect(handshakeCount).toBe(1);
    expect(writes).toBe(0);
  });

  it("preserves the open workspace and blocks pending and future actions when the service switches data directories", async () => {
    await open();
    localStorage.setItem(
      "miracle:sql-tabs:personal-workspace",
      JSON.stringify([{ id: "draft", sql: "select my_unsaved_sql" }]),
    );
    const viewBefore = localStorage.getItem("miracle:view:personal-workspace");
    let replacementWrites = 0;
    let replacementSession = false;
    const replacementCalls: string[] = [];
    fetcher.mockImplementation(
      async (path: string, options: RequestInit = {}) => {
        replacementCalls.push(path);
        if (path === "/api/session") {
          replacementSession = true;
          return response({
            workspaceId: "unrelated-workspace",
            csrfToken: "unrelated-csrf",
          });
        }
        if (!replacementSession) return response({ error: "Expired" }, 401);
        if (options.method === "POST") replacementWrites++;
        return response({ id: "unrelated-result" });
      },
    );
    await act(async () => {
      await expect(
        api("/api/connections", { method: "POST", body: "{}" }),
      ).rejects.toMatchObject({
        code: "WORKSPACE_CHANGED",
        message: expect.stringContaining("Перезагрузите страницу"),
      });
    });
    expect(replacementWrites).toBe(0);
    expect(replacementCalls).toEqual(["/api/connections", "/api/session"]);
    await expect(
      api("/api/connections", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    await expect(api("/api/queries")).rejects.toMatchObject({
      code: "WORKSPACE_CHANGED",
    });
    expect(replacementCalls).toEqual(["/api/connections", "/api/session"]);
    expect(
      container.querySelector('nav[aria-label="Рабочая область"]'),
    ).not.toBeNull();
    expect(
      localStorage.getItem("miracle:sql-tabs:personal-workspace"),
    ).toContain("my_unsaved_sql");
    expect(localStorage.getItem("miracle:view:personal-workspace")).toBe(
      viewBefore,
    );
    expect(localStorage.getItem("miracle:view:unrelated-workspace")).toBeNull();
    await click('[aria-label="SQL-файлы"]');
    expect(container.textContent).toContain("Перезагрузите страницу");
    expect(replacementWrites).toBe(0);
  });

  it.each(["GET", "POST"])(
    "blocks %s against a replacement workspace even when another tab installed its valid cookie",
    async (method) => {
      await open();
      localStorage.setItem(
        "miracle:sql-tabs:personal-workspace",
        "original unsaved SQL",
      );
      let replacementOperations = 0;
      const replacementCalls: string[] = [];
      fetcher.mockImplementation(
        async (path: string, options: RequestInit = {}) => {
          replacementCalls.push(path);
          // The browser already has workspace B's valid cookie, installed by a
          // second tab. Authentication succeeds; only the pinned workspace header
          // can reject this old tab before a read or mutation executes.
          const pinned = new Headers(options.headers).get(
            "X-Miracle-Workspace",
          );
          if (pinned && pinned !== "replacement-workspace")
            return response(
              { error: "Different workspace", code: "WORKSPACE_CHANGED" },
              409,
            );
          replacementOperations++;
          return response([
            { id: "replacement-query", name: "Other private query" },
          ]);
        },
      );
      await act(async () => {
        await expect(
          api("/api/queries", {
            method,
            ...(method === "POST" ? { body: "{}" } : {}),
          }),
        ).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
      });
      await expect(api("/api/queries")).rejects.toMatchObject({
        code: "WORKSPACE_CHANGED",
      });
      expect(replacementCalls).toEqual(["/api/queries"]);
      expect(replacementOperations).toBe(0);
      expect(handshakeCount).toBe(1);
      expect(container.textContent).toContain("Перезагрузите страницу");
      expect(container.textContent).not.toContain("Other private query");
      expect(localStorage.getItem("miracle:sql-tabs:personal-workspace")).toBe(
        "original unsaved SQL",
      );
      expect(
        container.querySelector('nav[aria-label="Рабочая область"]'),
      ).not.toBeNull();
    },
  );

  it("shows connection failure and permits reconnecting without an account form", async () => {
    fetcher.mockRejectedValueOnce(new TypeError("Service unavailable"));
    await open();
    expect(container.textContent).toContain("Service unavailable");
    const reconnect = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Подключиться снова",
    )!;
    await act(async () => reconnect.click());
    expect(
      container.querySelector('nav[aria-label="Рабочая область"]'),
    ).not.toBeNull();
  });
});
