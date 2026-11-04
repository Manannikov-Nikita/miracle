// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import AgentAssistant from "../src/client/agents/AgentAssistant";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";

let root: Root, host: HTMLDivElement;
let sent: any[], failSend: boolean, created: any, chat: any;
const png = new File(
  [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
  "reference.png",
  { type: "image/png" },
);
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent = [];
  failSend = false;
  created = null;
  chat = {
    id: "chat",
    title: "Images",
    profileId: "profile",
    provider: "codex",
    autoApprove: false,
  };
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/project")
      return { projectRoot: "/work/project" } as never;
    if (path === "/api/agent-profiles")
      return [
        { id: "profile", provider: "codex", name: "Codex", trusted: true },
      ] as never;
    if (path === "/api/agent-state") return { activeTurn: null } as never;
    if (path === "/api/chats") {
      if (options?.method === "POST") {
        created = JSON.parse(String(options.body));
        chat = { ...chat, ...created };
        return chat as never;
      }
      return (created ? [chat] : []) as never;
    }
    if (path === "/api/chats/chat/messages") {
      sent.push(JSON.parse(String(options?.body)));
      if (failSend) throw new Error("Connection interrupted");
      return {
        id: "turn",
        chatId: "chat",
        status: "completed",
        context: {},
      } as never;
    }
    if (path === "/api/chats/chat") {
      if (options?.method === "PATCH") {
        chat = { ...chat, ...JSON.parse(String(options.body)) };
        return chat as never;
      }
      return { chat, turns: [], messages: [] } as never;
    }
    return {} as never;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(AgentAssistant)));
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-controls="agent-panel"]')!
      .click(),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function attach(files = [png]) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function send() {
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
}

it("previews and sends image-only messages, clearing the sent draft", async () => {
  await attach();
  expect(host.querySelector("form img")?.getAttribute("alt")).toBe(
    "reference.png",
  );
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .disabled,
  ).toBe(false);
  await send();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    content: "",
    images: [
      {
        name: "reference.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    ],
  });
  expect(host.querySelector("form img")).toBeNull();
});

it("retains images and request identity after a lost response when creating a chat", async () => {
  failSend = true;
  await attach();
  await send();
  expect(host.querySelector("form img")).not.toBeNull();
  await send();
  expect(sent).toHaveLength(2);
  expect(sent[1].images).toEqual(sent[0].images);
  expect(sent[1].clientRequestId).toBe(sent[0].clientRequestId);
});

it("removes a reference and rejects unsupported or oversized inputs without losing other images", async () => {
  await attach();
  await attach([new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" })]);
  expect(host.querySelectorAll("form img")).toHaveLength(1);
  expect(host.textContent).toContain("PNG");
  await attach([
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    }),
  ]);
  expect(host.querySelectorAll("form img")).toHaveLength(1);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Убрать изображение reference.png"]',
      )!
      .click(),
  );
  expect(host.querySelector("form img")).toBeNull();
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .disabled,
  ).toBe(true);
});

it("accepts pasted and dropped image files", async () => {
  for (const kind of ["paste", "drop"]) {
    await act(async () => {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(
        event,
        kind === "paste" ? "clipboardData" : "dataTransfer",
        { value: { files: [png], types: ["Files"] } },
      );
      host.querySelector("textarea")!.dispatchEvent(event);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
  expect(host.querySelectorAll("form img")).toHaveLength(2);
});

it("does not accept attachments during a new-chat send", async () => {
  await attach();
  const original = vi.mocked(api).getMockImplementation()!;
  let release!: () => void;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/chats" && options?.method === "POST")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original(path, options);
  });
  await send();
  expect(
    host.querySelector<HTMLInputElement>('input[type="file"]')!.disabled,
  ).toBe(true);
  await act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [png] } });
    host.querySelector("textarea")!.dispatchEvent(event);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(host.querySelectorAll("form img")).toHaveLength(1);
  await act(async () => release());
});

it("creates chats with the chosen approval policy and can disable it for the existing chat", async () => {
  const toggle = () =>
    host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Автоапрув"]',
    )!;
  expect(toggle()).not.toBeNull();
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  await attach();
  await send();
  expect(created.autoApprove).toBe(true);
  await act(async () => toggle().click());
  expect(chat.autoApprove).toBe(false);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});
