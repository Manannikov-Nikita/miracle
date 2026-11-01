// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import Connections from "../src/client/components/Connections";
import {
  certificatePresent,
  clickhouseFormError,
  connectionProtocol,
} from "../src/client/components/ClickHouseConnectionOptions";
import type { Connection } from "../src/shared/types";

const saved: Connection = {
  id: "ch",
  name: "Warehouse",
  engine: "clickhouse",
  url: "https://warehouse.test:8443",
  username: "reader",
  hasPassword: true,
  clickhouse: {
    requestTimeoutMs: 40000,
    compression: true,
    settings: { max_threads: "4" },
    tls: {
      hasCaCert: true,
      hasClientCert: true,
      hasClientKey: true,
      certificateAuth: false,
    },
  },
};

describe("ClickHouse connection protocol and TLS preservation", () => {
  it("switches ClickHouse standard ports and preserves custom ports, paths and queries", () => {
    expect(connectionProtocol("http://warehouse.test:8123", true)).toBe(
      "https://warehouse.test:8443",
    );
    expect(connectionProtocol("https://warehouse.test:8443", false)).toBe(
      "http://warehouse.test:8123",
    );
    expect(
      connectionProtocol("http://warehouse.test:9440/proxy?cluster=one", true),
    ).toBe("https://warehouse.test:9440/proxy?cluster=one");
  });
  it("preserves omitted secrets and validates the final stored/uploaded pair", () => {
    expect(certificatePresent({}, saved.clickhouse, "clientKey")).toBe(true);
    expect(
      certificatePresent({ tls: null }, saved.clickhouse, "clientKey"),
    ).toBe(false);
    expect(
      clickhouseFormError(
        saved.url,
        { tls: { clientCert: "PEM replacement" } },
        saved.clickhouse,
      ),
    ).toBe("");
    expect(
      clickhouseFormError(
        saved.url,
        { tls: { clientKey: null } },
        saved.clickhouse,
      ),
    ).toContain("mTLS");
    expect(
      clickhouseFormError("http://warehouse.test:8123", {}, saved.clickhouse),
    ).toContain("HTTPS");
    expect(
      clickhouseFormError(
        "http://warehouse.test:8123",
        { tls: null },
        saved.clickhouse,
      ),
    ).toBe("");
    expect(
      clickhouseFormError(saved.url, { tls: { certificateAuth: true } }),
    ).toContain("входа по сертификату");
  });
});

describe("connection form", () => {
  let root: Root;
  let host: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, version: "25.1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(Connections, {
          open: true,
          onClose: vi.fn(),
          connections: [saved],
          onChanged: vi.fn(),
          onNotify: vi.fn(),
        }),
      ),
    );
    await click('[aria-label="Настроить Warehouse"]');
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function click(selector: string) {
    await act(async () => {
      (document.querySelector(selector) as HTMLElement).click();
    });
  }
  async function input(selector: string, value: string) {
    await act(async () => {
      const target = document.querySelector(selector) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === label,
    )!;
  const body = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
  it("shows the fixed engine while editing and only offers engine choices for a new connection", async () => {
    expect(document.querySelector(".engine-picker")).toBeNull();
    expect(document.querySelector(".connection-engine")?.textContent).toContain(
      "ClickHouse",
    );
    await act(async () => button("Назад").click());
    expect(
      document.querySelector('[aria-label="Проверить Warehouse"]'),
    ).not.toBeNull();
    await act(async () => button("Новое подключение").click());
    const choices = [...document.querySelectorAll(".engine-option")];
    expect(choices).toHaveLength(2);
    expect(choices[0].getAttribute("aria-pressed")).toBe("true");
    await act(async () => (choices[1] as HTMLButtonElement).click());
    expect(choices[1].getAttribute("aria-pressed")).toBe("true");
    expect(choices[0].getAttribute("aria-pressed")).toBe("false");
  });
  it("locks the tested draft and back navigation until its request completes", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => button("Проверить").click());
    expect(
      document.querySelector('input[type="url"]')?.matches(":disabled"),
    ).toBe(true);
    expect(
      document.querySelector('input[type="password"]')?.matches(":disabled"),
    ).toBe(true);
    expect(button("Назад").disabled).toBe(true);
    await act(async () =>
      finish(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    expect(
      document.querySelector('input[type="url"]')?.matches(":disabled"),
    ).toBe(false);
    expect(button("Назад").disabled).toBe(false);
    expect(document.body.textContent).toContain("Доступно");
  });
  it("round-trips public options without converting presence flags to secrets, tests unsaved edits and clears stale results", async () => {
    expect(
      document
        .querySelector('input[type="password"]')
        ?.getAttribute("placeholder"),
    ).toContain("Сохранён");
    expect(
      document.body.textContent?.match(/Сохранён/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    await input('input[type="url"]', "https://changed.test:8443");
    await act(async () => button("Проверить").click());
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/connections/test");
    expect(body()).toMatchObject({
      id: "ch",
      url: "https://changed.test:8443",
      clickhouse: {
        requestTimeoutMs: 40000,
        compression: true,
        settings: { max_threads: "4" },
        tls: { certificateAuth: false },
      },
    });
    expect(JSON.stringify(body())).not.toContain("hasCaCert");
    expect(JSON.stringify(body())).not.toContain("caCert");
    expect(document.body.textContent).toContain("Доступно · 25.1");
    await input('input[type="url"]', "https://another.test:8443");
    expect(document.body.textContent).not.toContain("Доступно · 25.1");
    await act(async () => button("Сохранить").click());
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/connections/ch");
    expect(body().clickhouse.tls).toEqual({ certificateAuth: false });
    expect(body().password).toBeUndefined();
  });
  it("blocks HTTP with existing TLS material until the user explicitly removes it", async () => {
    await click('.connection-checkbox input[type="checkbox"]');
    expect(
      (document.querySelector('input[type="url"]') as HTMLInputElement).value,
    ).toBe("http://warehouse.test:8123");
    await act(async () => button("Проверить").click());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Сертификаты требуют HTTPS");
    await act(async () => button("Удалить все сертификаты").click());
    await act(async () => button("Проверить").click());
    expect(body().clickhouse.tls).toBeNull();
  });
  it("uses certificate auth only explicitly and keeps password input disabled while enabled", async () => {
    const checkbox = Array.from(
      document.querySelectorAll('input[type="checkbox"]'),
    ).find((node) =>
      node.closest("label")?.textContent?.includes("Вход в ClickHouse"),
    ) as HTMLInputElement;
    await act(async () => checkbox.click());
    expect(
      (document.querySelector('input[type="password"]') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await act(async () => button("Проверить").click());
    expect(body().clickhouse.tls).toEqual({ certificateAuth: true });
    expect(body().username).toBe("reader");
  });
  it("uploads replacement PEM privately and preserves explicit removals after resetting TLS", async () => {
    await act(async () => button("Удалить все сертификаты").click());
    const pem =
      "-----BEGIN CERTIFICATE-----\nPRIVATE TEST CONTENT\n-----END CERTIFICATE-----";
    const target = document.querySelector(
      'input[aria-label="Корневой сертификат CA"]',
    ) as HTMLInputElement;
    const file = new File([pem], "root.pem");
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode(pem).buffer,
    });
    await act(async () => {
      Object.defineProperty(target, "files", {
        configurable: true,
        value: [file],
      });
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("root.pem");
    expect(document.body.textContent).not.toContain("PRIVATE TEST CONTENT");
    await act(async () => button("Проверить").click());
    expect(body().clickhouse.tls).toEqual({
      caCert: pem,
      clientCert: null,
      clientKey: null,
      certificateAuth: false,
    });
  });
  it("rejects oversized file uploads without leaking file contents", async () => {
    const target = document.querySelector(
      'input[aria-label="Корневой сертификат CA"]',
    ) as HTMLInputElement;
    const file = new File(["secret".repeat(23000)], "too-big.pem");
    await act(async () => {
      Object.defineProperty(target, "files", {
        configurable: true,
        value: [file],
      });
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("не больше 128 КиБ");
    expect(document.body.textContent).not.toContain("secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
