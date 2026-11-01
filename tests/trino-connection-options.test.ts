// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import Connections from "../src/client/components/Connections";
import type { Connection } from "../src/shared/types";

const saved: Connection = {
  id: "trino",
  name: "Corporate warehouse",
  engine: "trino",
  url: "https://warehouse.test:8443/trino",
  username: "reader",
  hasPassword: true,
  trino: { tls: { hasCaCert: true } },
};
const pem =
  "-----BEGIN CERTIFICATE-----\nPRIVATE TEST CA\n-----END CERTIFICATE-----\n";
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const onChanged = vi.fn();
const onNotify = vi.fn();
async function render(open = true) {
  await act(async () =>
    root.render(
      createElement(Connections, {
        open,
        onClose: vi.fn(),
        connections: [saved],
        onChanged,
        onNotify,
      }),
    ),
  );
}
async function click(selector: string) {
  const target = document.querySelector<HTMLElement>(selector);
  expect(target).not.toBeNull();
  await act(async () => target!.click());
}
function button(label: string) {
  const target = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((node) =>
    node.classList.contains("engine-option")
      ? node.textContent?.includes(label)
      : node.textContent?.trim() === label,
  );
  expect(target, label).toBeDefined();
  return target!;
}
async function input(selector: string, value: string) {
  const target = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function file(content = pem, name = "corporate-ca.pem") {
  const value = new File([content], name);
  Object.defineProperty(value, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return value;
}
async function upload(value: File) {
  const target = document.querySelector<HTMLInputElement>(
    'input[aria-label="Корневой сертификат CA"]',
  );
  expect(target).not.toBeNull();
  await act(async () => {
    Object.defineProperty(target, "files", {
      configurable: true,
      value: [value],
    });
    target!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function requestBody() {
  return JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, version: "478" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  onChanged.mockClear();
  onNotify.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
  await click('[aria-label="Настроить Corporate warehouse"]');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Trino connection CA", () => {
  it("preserves saved CA when checking and saving edits without returning presence flags as secrets", async () => {
    expect(
      document.querySelector('input[aria-label="Корневой сертификат CA"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Сохранён");
    await input('input[type="url"]', "https://changed.test:8443/trino");
    await act(async () => button("Проверить").click());
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/connections/test");
    expect(requestBody()).toMatchObject({
      id: "trino",
      url: "https://changed.test:8443/trino",
    });
    expect(JSON.stringify(requestBody())).not.toContain("hasCaCert");
    expect(JSON.stringify(requestBody())).not.toContain("caCert");
    expect(document.body.textContent).toContain("Доступно · 478");
    await input('input[type="url"]', "https://next.test/trino");
    expect(document.body.textContent).not.toContain("Доступно · 478");
    await act(async () => button("Сохранить").click());
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/connections/trino");
    expect(requestBody().password).toBeUndefined();
    expect(JSON.stringify(requestBody())).not.toContain("caCert");
  });

  it("tests and saves an uploaded replacement, showing only its filename", async () => {
    await upload(file());
    expect(document.body.textContent).toContain("corporate-ca.pem");
    expect(document.body.textContent).not.toContain("PRIVATE TEST CA");
    await act(async () => button("Проверить").click());
    expect(requestBody().trino).toEqual({ tls: { caCert: pem } });
    await act(async () => button("Сохранить").click());
    expect(requestBody().trino).toEqual({ tls: { caCert: pem } });
    await click('[aria-label="Настроить Corporate warehouse"]');
    expect(document.body.textContent).toContain("Сохранён");
    expect(document.body.textContent).not.toContain("corporate-ca.pem");
    expect(document.body.textContent).not.toContain("PRIVATE TEST CA");
  });

  it("requires HTTPS for retained CA and only removes it explicitly", async () => {
    await click('.connection-checkbox input[type="checkbox"]');
    expect(
      (document.querySelector('input[type="url"]') as HTMLInputElement).value,
    ).toBe("http://warehouse.test:8443/trino");
    await act(async () => button("Проверить").click());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("CA требует HTTPS");
    await click('[aria-label="Удалить: Корневой сертификат CA"]');
    await act(async () => button("Проверить").click());
    expect(requestBody().trino).toEqual({ tls: { caCert: null } });
    await act(async () => button("Сохранить").click());
    expect(requestBody().trino).toEqual({ tls: { caCert: null } });
  });

  it("keeps Trino ports and paths when enabling HTTPS", async () => {
    await input('input[type="url"]', "http://gateway.test:8080/trino");
    await click('.connection-checkbox input[type="checkbox"]');
    expect(
      (document.querySelector('input[type="url"]') as HTMLInputElement).value,
    ).toBe("https://gateway.test:8080/trino");
    await input('input[type="url"]', "http://gateway.test/trino");
    await click('.connection-checkbox input[type="checkbox"]');
    expect(
      (document.querySelector('input[type="url"]') as HTMLInputElement).value,
    ).toBe("https://gateway.test/trino");
  });

  it.each([
    ["too-big.pem", "secret".repeat(23000), "не больше 128 КиБ"],
    [
      "private.key",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      "PEM",
    ],
    ["wrong.pem", "secret", "PEM"],
  ])(
    "rejects invalid certificate upload %s while retaining the saved CA",
    async (name, content, message) => {
      await upload(file(content, name));
      expect(document.body.textContent).toContain(message);
      expect(document.body.textContent).not.toContain("secret");
      expect(document.body.textContent).toContain("Сохранён");
      await act(async () => button("Проверить").click());
      expect(JSON.stringify(requestBody())).not.toContain("caCert");
    },
  );

  it("blocks save/test during reading and ignores a late upload after leaving the form", async () => {
    let finish!: (buffer: ArrayBuffer) => void;
    const pending = new File([pem], "late-ca.pem");
    Object.defineProperty(pending, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    });
    await upload(pending);
    expect(button("Проверить").disabled).toBe(true);
    expect(button("Сохранить").disabled).toBe(true);
    await act(async () => button("Назад").click());
    await click('[aria-label="Настроить Corporate warehouse"]');
    await act(async () => finish(new TextEncoder().encode(pem).buffer));
    expect(document.body.textContent).not.toContain("late-ca.pem");
    expect(button("Проверить").disabled).toBe(false);
    await act(async () => button("Проверить").click());
    expect(JSON.stringify(requestBody())).not.toContain("caCert");
  });

  it("rejects malformed UTF-8 inside a PEM envelope instead of uploading replacement characters", async () => {
    const start = new TextEncoder().encode("-----BEGIN CERTIFICATE-----\n");
    const end = new TextEncoder().encode("\n-----END CERTIFICATE-----");
    const bytes = new Uint8Array([...start, 0xff, ...end]);
    const malformed = new File([bytes], "bad-encoding.pem");
    Object.defineProperty(malformed, "arrayBuffer", {
      value: async () => bytes.buffer,
    });
    await upload(malformed);
    expect(document.body.textContent).toContain("UTF-8");
    expect(document.body.textContent).not.toContain("bad-encoding.pem");
    await act(async () => button("Проверить").click());
    expect(JSON.stringify(requestBody())).not.toContain("caCert");
  });

  it("clears uploaded Trino CA when switching a new connection to ClickHouse and back", async () => {
    await act(async () => button("Назад").click());
    await act(async () => button("Новое подключение").click());
    await act(async () => button("Trino").click());
    await input('input[type="url"]', "https://gateway.test");
    await upload(file());
    await act(async () => button("ClickHouse").click());
    await act(async () => button("Trino").click());
    expect(document.body.textContent).not.toContain("corporate-ca.pem");
    expect(document.body.textContent).toContain("Не выбран");
  });
});
