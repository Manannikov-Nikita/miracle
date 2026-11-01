// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentProfiles from "../src/client/agents/AgentProfiles";
import type { AgentProfile } from "../src/shared/agents";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";

const profiles: AgentProfile[] = [
  {
    id: "codex",
    name: "Local Codex",
    provider: "codex",
    command: "codex",
    trusted: true,
    createdAt: "now",
  },
  {
    id: "claude",
    name: "Analysis Claude",
    provider: "claude",
    command: "claude --model sonnet",
    trusted: true,
    createdAt: "now",
  },
];
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.id = "agent-panel";
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(initialProfileId = "claude", values = profiles) {
  const onChanged = vi.fn(async () => {});
  await act(async () =>
    root.render(
      createElement(AgentProfiles, {
        profiles: values,
        initialProfileId,
        onChanged,
      }),
    ),
  );
  return onChanged;
}
function button(name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === name || item.textContent === name,
  )!;
}
function select() {
  return host.querySelector<HTMLSelectElement>('select[aria-label="Профиль"]')!;
}

it("opens the selected profile, and falls back to an available profile when it is missing", async () => {
  await render();
  expect(select().value).toBe("claude");
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe(
    "Analysis Claude",
  );
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
    "claude --model sonnet",
  );
  await act(async () => root.unmount());
  root = createRoot(host);
  await render("deleted");
  expect(select().value).toBe("codex");
});

it("starts a distinct new profile without overwriting the existing selection", async () => {
  await render();
  await act(async () => button("Новый профиль агента").click());
  expect(select().value).toBe("");
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
    "codex",
  );
  expect(api).not.toHaveBeenCalled();
});

it("requires deletion confirmation and restores the trigger after cancelling", async () => {
  const changed = await render();
  const trigger = button("Удалить профиль");
  await act(async () => trigger.click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
    "Analysis Claude",
  );
  expect(api).not.toHaveBeenCalled();
  await act(async () => button("Отмена").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(document.activeElement).toBe(trigger);
  expect(api).not.toHaveBeenCalled();
  vi.mocked(api).mockResolvedValue({} as never);
  await act(async () => trigger.click());
  await act(async () => button("Удалить").click());
  expect(api).toHaveBeenCalledWith("/api/agent-profiles/claude", {
    method: "DELETE",
  });
  expect(changed).toHaveBeenCalledOnce();
  expect(select().value).toBe("codex");
});

it("locks profile switching and editing until save and validation finish", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation((path) =>
    path.endsWith("/validate")
      ? (Promise.resolve({
          version: "v1",
          commandPreview: "claude",
          executable: "claude",
        }) as never)
      : (new Promise((resolve) => {
          finish = resolve;
        }) as never),
  );
  await render();
  await act(async () => button("Сохранить и проверить").click());
  for (const field of host.querySelectorAll("input, select, textarea"))
    expect(field.matches(":disabled")).toBe(true);
  expect(button("Новый профиль агента").matches(":disabled")).toBe(true);
  await act(async () => {
    select().value = "codex";
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe(
    "Analysis Claude",
  );
  await act(async () => finish(profiles[1]));
  expect(host.querySelector("input")!.matches(":disabled")).toBe(false);
  expect(select().value).toBe("claude");
});
