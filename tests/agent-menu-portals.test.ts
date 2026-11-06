// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentComposer, {
  type ComposerProps,
} from "../src/client/agents/AgentComposer";
import type { AgentChatState } from "../src/client/agents/useAgentChat";

let host: HTMLDivElement, root: Root;
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

function props(): ComposerProps {
  return {
    state: {
      selected: "",
      profiles: [
        {
          id: "profile",
          name: "Local Codex",
          provider: "codex",
          trusted: true,
        },
      ],
      chats: [],
      busy: false,
      active: null,
      setSelected: vi.fn(),
    } as unknown as AgentChatState,
    selectedProfile: "profile",
    onProfileChange: vi.fn(),
    draft: "",
    onDraftChange: vi.fn(),
    onSend: vi.fn(async () => {}),
    onSettings: vi.fn(),
    onImagesAdd: vi.fn(async () => {}),
  };
}

async function openPanel(value: ComposerProps) {
  await act(async () =>
    root.render(
      createElement(
        "aside",
        { id: "agent-panel" },
        createElement(AgentComposer, value),
      ),
    ),
  );
  return host.querySelector<HTMLElement>("#agent-panel")!;
}

async function openMenu(label: string) {
  const trigger = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

it.each(["Добавить вложение", "Действия чата", "Выбрать профиль агента"])(
  "keeps %s inside the panel on its first mount and after reopening",
  async (label) => {
    const value = props();
    const firstPanel = await openPanel(value);
    const firstMenu = await openMenu(label);
    expect(firstMenu).not.toBeNull();
    expect(firstPanel.contains(firstMenu)).toBe(true);

    await act(async () => root.render(null));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const reopenedPanel = await openPanel(value);
    expect(reopenedPanel).not.toBe(firstPanel);
    const reopenedMenu = await openMenu(label);
    expect(reopenedPanel.contains(reopenedMenu)).toBe(true);
    expect(document.body.style.pointerEvents).not.toBe("none");
  },
);
