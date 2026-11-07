// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentAssistant from "../src/client/agents/AgentAssistant";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";
let root: Root,
  host: HTMLDivElement,
  accept: (value: unknown) => void,
  reject: (error: Error) => void;
let sent: unknown[];
const turn = {
  id: "turn",
  chatId: "chat",
  status: "running",
  context: {},
  createdAt: "now",
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent = [];
  const chat = {
    id: "chat",
    profileId: "profile",
    provider: "codex",
    title: "Analysis",
  };
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/project") return { projectRoot: "/work" } as never;
    if (path === "/api/agent-profiles")
      return [
        { id: "profile", name: "Codex", provider: "codex", trusted: true },
      ] as never;
    if (path === "/api/chats") return [chat] as never;
    if (path === "/api/agent-state") return { activeTurn: turn } as never;
    if (path === "/api/chats/chat")
      return { chat, messages: [], turns: [] } as never;
    if (path === "/api/agent-turns/turn/steer") {
      sent.push(JSON.parse(String(options?.body)));
      return new Promise((a, r) => {
        accept = a;
        reject = r;
      }) as never;
    }
    if (path.endsWith("/sql-activity"))
      return { runs: [], activeCount: 0 } as never;
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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function type(value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>("#agent-message")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const send = () =>
  act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Направить агента"]')!
      .click(),
  );
it("preserves a newer draft typed while steering input is being acknowledged", async () => {
  await type("Первое уточнение");
  await send();
  expect(sent).toHaveLength(1);
  await type("Второе уточнение");
  await act(async () => accept(turn));
  expect(host.querySelector<HTMLTextAreaElement>("#agent-message")!.value).toBe(
    "Второе уточнение",
  );
});
it("retains text and request identity after a rejected steering HTTP request", async () => {
  await type("Уточнение");
  await send();
  await act(async () => reject(new Error("Связь прервалась")));
  expect(host.querySelector<HTMLTextAreaElement>("#agent-message")!.value).toBe(
    "Уточнение",
  );
  await send();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  await act(async () => accept(turn));
  expect(host.querySelector<HTMLTextAreaElement>("#agent-message")!.value).toBe(
    "",
  );
});

it("can remove an image and stop while its steer is pending without losing a newer draft", async () => {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, "files", {
      value: [new File(["image"], "reference.png", { type: "image/png" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  await send();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    content: "",
    images: [{ name: "reference.png", mimeType: "image/png" }],
  });
  const submitted = structuredClone(sent[0]);
  const remove = host.querySelector<HTMLButtonElement>(
    '[aria-label="Убрать изображение reference.png"]',
  )!;
  expect(remove.disabled).toBe(false);
  await act(async () => remove.click());
  expect(host.querySelector("form img")).toBeNull();
  const stop = host.querySelector<HTMLButtonElement>(
    '[aria-label="Остановить"]',
  )!;
  expect(stop.disabled).toBe(false);
  await act(async () => stop.click());
  expect(api).toHaveBeenCalledWith("/api/agent-turns/turn/cancel", {
    method: "POST",
  });
  await type("Следующее уточнение");
  await act(async () => accept(turn));
  expect(sent[0]).toEqual(submitted);
  expect(host.querySelector<HTMLTextAreaElement>("#agent-message")!.value).toBe(
    "Следующее уточнение",
  );
  expect(host.querySelector("form img")).toBeNull();
});
