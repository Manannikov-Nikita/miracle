// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentMessages from "../src/client/agents/AgentMessages";
import type { AgentChatState } from "../src/client/agents/useAgentChat";

let root: Root, host: HTMLDivElement;
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
function state() {
  return {
    selected: "chat",
    busy: false,
    resolvedApprovals: new Map(),
    active: { id: "turn", chatId: "chat", status: "waiting" },
    answerQuestion: vi.fn(async () => {}),
    conversation: {
      chat: { id: "chat", provider: "codex" },
      turns: [],
      messages: [
        {
          id: "prompt",
          chatId: "chat",
          turnId: "turn",
          role: "question",
          content: "Уточнение",
          createdAt: "now",
          details: {
            question: {
              id: "request",
              status: "pending",
              questions: [
                {
                  id: "metric",
                  header: "Метрика",
                  question: "Какую метрику считать?",
                  options: [{ label: "Выручка" }, { label: "Прибыль" }],
                  multiSelect: false,
                  allowOther: true,
                },
                {
                  id: "regions",
                  header: "Регионы",
                  question: "Какие регионы включить?",
                  options: [{ label: "Москва" }, { label: "Казань" }],
                  multiSelect: true,
                  allowOther: true,
                },
              ],
            },
          },
        },
      ],
    },
  } as unknown as AgentChatState;
}
const render = async (value: AgentChatState) =>
  act(async () => root.render(createElement(AgentMessages, { state: value })));
it("answers one native request with a single choice and multiple selected regions", async () => {
  const value = state();
  await render(value);
  const fields = host.querySelectorAll("fieldset");
  expect(fields).toHaveLength(2);
  await act(async () => {
    fields[0]
      .querySelector<HTMLInputElement>('input[value="Прибыль"]')!
      .click();
    fields[1].querySelector<HTMLInputElement>('input[value="Москва"]')!.click();
    fields[1].querySelector<HTMLInputElement>('input[value="Казань"]')!.click();
  });
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(value.answerQuestion).toHaveBeenCalledWith("request", {
    metric: ["Прибыль"],
    regions: ["Москва", "Казань"],
  });
});
it("retains answers on failed delivery and never double submits a pending answer", async () => {
  const value = state();
  let reject!: (error: Error) => void;
  value.answerQuestion = vi.fn(
    () =>
      new Promise<void>((_resolve, r) => {
        reject = r;
      }),
  );
  await render(value);
  expect(host.querySelector("form")).not.toBeNull();
  await act(async () => {
    host.querySelector<HTMLInputElement>('input[value="Выручка"]')!.click();
    host.querySelector<HTMLInputElement>('input[value="Москва"]')!.click();
  });
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(value.answerQuestion).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Нет связи")));
  expect(host.textContent).toContain("Нет связи");
  expect(
    host.querySelector<HTMLInputElement>('input[value="Выручка"]')!.checked,
  ).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>('input[value="Москва"]')!.checked,
  ).toBe(true);
});
it("closes stale questions when their turn ends and does not reuse a later waiting turn", async () => {
  const value = state();
  value.active = { ...value.active!, id: "later" };
  await render(value);
  expect(host.textContent).toContain("Запрос закрыт");
  expect(host.querySelector("form")).toBeNull();
});
it("keeps a steering message between the earlier reply and the following reply", async () => {
  const value = state();
  value.active = null;
  value.conversation!.messages = [
    { id: "u", role: "user", content: "Исследуй данные" },
    { id: "a", role: "assistant", content: "Начинаю анализ" },
    {
      id: "s",
      role: "user",
      content: "Добавь 2025 год",
      details: { steer: true },
    },
    { id: "b", role: "assistant", content: "Добавил 2025 год" },
  ].map((message) => ({
    ...message,
    chatId: "chat",
    turnId: "turn",
    createdAt: "now",
  })) as typeof value.conversation.messages;
  await render(value);
  expect(
    [...host.querySelectorAll("article")].map((article) => article.textContent),
  ).toEqual([
    expect.stringContaining("Исследуй данные"),
    expect.stringContaining("Начинаю анализ"),
    expect.stringContaining("Добавь 2025 год"),
    expect.stringContaining("Добавил 2025 год"),
  ]);
});

it("lets a custom answer replace a single option while retaining multiple selections elsewhere", async () => {
  const value = state();
  await render(value);
  await act(async () => {
    host.querySelector<HTMLInputElement>('input[value="Выручка"]')!.click();
    host.querySelector<HTMLInputElement>('input[value="Москва"]')!.click();
  });
  await act(async () => {
    const input = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Свой ответ: Метрика"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "Средний чек");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(value.answerQuestion).toHaveBeenCalledWith("request", {
    metric: ["Средний чек"],
    regions: ["Москва"],
  });
  expect(
    host.querySelector<HTMLInputElement>('input[value="Выручка"]')!.checked,
  ).toBe(false);
});
it("shows an unconfirmed steer as unconfirmed in persisted chat history", async () => {
  const value = state();
  value.active = null;
  value.conversation!.messages = [
    {
      id: "steer",
      chatId: "chat",
      turnId: "turn",
      role: "user",
      content: "Уточнение",
      createdAt: "now",
      details: { steer: { status: "failed", error: "Связь прервалась" } },
    },
  ];
  await render(value);
  expect(host.textContent).toContain("Доставка не подтверждена");
  expect(host.textContent).toContain("Связь прервалась");
});
it("keeps question answering available while a steer waits for the provider",async()=>{
 const value=state();value.busy=true;
 await render(value);
 expect(host.querySelector<HTMLInputElement>('input[value="Прибыль"]')!.matches(":disabled")).toBe(false);
 await act(async()=>{host.querySelector<HTMLInputElement>('input[value="Прибыль"]')!.click();host.querySelector<HTMLInputElement>('input[value="Москва"]')!.click();});
 await act(async()=>host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(value.answerQuestion).toHaveBeenCalledWith("request",{metric:["Прибыль"],regions:["Москва"]});
});
it("keeps permission decisions available while a steer is awaiting delivery",async()=>{
 const value=state();value.busy=true;value.approve=vi.fn(async()=>{});
 value.conversation!.messages=[{id:"approval",chatId:"chat",turnId:"turn",role:"approval",content:"Разрешить чтение?",createdAt:"now",details:{approvalId:"permission"}}];
 await render(value);
 const allow=[...host.querySelectorAll("button")].find(button=>button.textContent==="Разрешить")!;
 expect(allow.disabled).toBe(false);await act(async()=>allow.click());expect(value.approve).toHaveBeenCalledWith("permission","allow");
});
