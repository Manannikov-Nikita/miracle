// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentModelSettings from "../src/client/agents/AgentModelSettings";
import type { AgentModelCatalog } from "../src/shared/agents";
vi.mock("../src/client/api", () => ({ api: vi.fn() }));
import { api } from "../src/client/api";

const catalog: AgentModelCatalog = {
  models: [
    {
      id: "model-a",
      name: "Model A",
      reasoningEfforts: [{ id: "low" }, { id: "high" }],
    },
    { id: "model-b", name: "Model B", reasoningEfforts: [{ id: "medium" }] },
  ],
  defaultModel: "model-a",
};
describe("agent model picker", () => {
  let host: HTMLDivElement, root: Root;
  const change = vi.fn(async () => {});
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(api).mockReset().mockResolvedValue(catalog);
    change.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(
    props: Partial<Parameters<typeof AgentModelSettings>[0]> = {},
    key = "chat",
  ) {
    await act(async () =>
      root.render(
        createElement(
          "aside",
          { id: "agent-panel" },
          createElement(AgentModelSettings, {
            key,
            profileId: "profile",
            trusted: true,
            onChange: change,
            ...props,
          }),
        ),
      ),
    );
  }
  async function open() {
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Модель и рассуждение"]',
        )!
        .dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
  }
  const radio = (text: string) =>
    [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent === text,
    )!;

  it("loads only when opened and keeps its portal inside the chat panel", async () => {
    await render();
    expect(api).not.toHaveBeenCalled();
    await open();
    expect(api).toHaveBeenCalledWith(
      "/api/agent-profiles/profile/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      host
        .querySelector("#agent-panel")!
        .contains(host.querySelector('[role="menu"]')),
    ).toBe(true);
    expect(radio("Model A")).toBeTruthy();
    expect(radio("Высокий")).toBeTruthy();
  });

  it("changes model without carrying an unsupported previous reasoning effort", async () => {
    await render({ settings: { model: "model-a", reasoningEffort: "high" } });
    await open();
    await act(async () => radio("Model B").click());
    expect(change).toHaveBeenCalledWith({ model: "model-b" });
    await render({ settings: { model: "model-b" } });
    expect(radio("Средний")).toBeTruthy();
    expect(radio("Высокий")).toBeUndefined();
    await act(async () => radio("Средний").click());
    expect(change).toHaveBeenLastCalledWith({
      model: "model-b",
      reasoningEffort: "medium",
    });
  });

  it("does not discover models for an untrusted profile or while controls are disabled", async () => {
    await render({ trusted: false });
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
    expect(api).not.toHaveBeenCalled();
    await render({ disabled: true });
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
    expect(api).not.toHaveBeenCalled();
  });

  it("shows an error and retry without claiming unknown profile defaults", async () => {
    vi.mocked(api).mockRejectedValueOnce(
      new Error("Обновите CLI, чтобы получить список моделей."),
    );
    await render();
    await open();
    expect(host.textContent).toContain("Не удалось загрузить модели");
    expect(host.textContent).toContain("Обновите CLI");
    expect(host.textContent).not.toContain("Model A");
    const retry = [
      ...host.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes("Повторить"))!;
    await act(async () => retry.click());
    expect(radio("Model A")).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("aborts discovery and ignores its late answer after a chat/profile switch", async () => {
    let release!: (value: AgentModelCatalog) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    await open();
    expect(host.textContent).toContain("Загружаем модели");
    const signal = vi.mocked(api).mock.calls[0][1]!.signal!;
    await render({ profileId: "other" }, "other-chat");
    expect(signal.aborted).toBe(true);
    await act(async () => release(catalog));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.textContent).not.toContain("Model A");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("resets all explicit overrides with the profile choice", async () => {
    await render({ settings: { model: "model-a", reasoningEffort: "high" } });
    await open();
    const modelGroup = host.querySelector(
      '[role="group"][aria-label="Модель"]',
    )!;
    const reset = modelGroup.querySelector<HTMLElement>(
      '[role="menuitemradio"]',
    )!;
    await act(async () => reset.click());
    expect(change).toHaveBeenCalledWith({});
  });

  it("uses automatic reasoning defaults and shows effort-only overrides in the trigger tooltip", async () => {
    await render({ settings: { reasoningEffort: "high" } });
    expect(host.querySelector<HTMLButtonElement>("button")!.title).toContain(
      "Высокий",
    );
    await open();
    const reasoningGroup = host.querySelector(
      '[role="group"][aria-label="Уровень рассуждений"]',
    )!;
    expect(reasoningGroup.textContent).toContain("Автоматически");
    expect(reasoningGroup.textContent).not.toContain("Из профиля");
    await act(async () =>
      reasoningGroup
        .querySelector<HTMLElement>('[role="menuitemradio"]')!
        .click(),
    );
    expect(change).toHaveBeenCalledWith({});
  });
});
