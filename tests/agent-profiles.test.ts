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
const ready = () => host.textContent?.includes("профиль готов к работе");
const validation = {
  version: "v1",
  commandPreview: "codex app-server",
  executable: "codex",
};

it("does not report a trusted profile ready before validating its current command", async () => {
  await render("codex");
  expect(ready()).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

it("reports readiness only after validation succeeds and withdraws it while rechecking or after failure", async () => {
  let resolveValidation!: (value: unknown) => void;
  let rejectValidation!: (error: Error) => void;
  vi.mocked(api).mockImplementation((path) =>
    path.endsWith("/validate")
      ? (new Promise((resolve, reject) => {
          resolveValidation = resolve;
          rejectValidation = reject;
        }) as never)
      : (Promise.resolve(profiles[0]) as never),
  );
  await render("codex");
  await act(async () => button("Сохранить и проверить").click());
  expect(ready()).toBe(false);
  await act(async () => resolveValidation(validation));
  expect(ready()).toBe(true);

  await act(async () => button("Сохранить и проверить").click());
  expect(ready()).toBe(false);
  await act(async () => rejectValidation(new Error("Invalid configuration")));
  expect(host.textContent).toContain("Invalid configuration");
  expect(ready()).toBe(false);
  expect(
    host.querySelector('[aria-label="Фактическая команда запуска"]'),
  ).toBeNull();
  // Other dialog actions clear the error; they must not restore stale readiness.
  await act(async () => button("Удалить профиль").click());
  await act(async () => button("Отмена").click());
  expect(ready()).toBe(false);
});

it("invalidates a successful validation when the command changes", async () => {
  vi.mocked(api).mockImplementation(
    (path) =>
      Promise.resolve(
        path.endsWith("/validate") ? validation : profiles[0],
      ) as never,
  );
  await render("codex");
  await act(async () => button("Сохранить и проверить").click());
  expect(ready()).toBe(true);
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "codex --model different");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(ready()).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "codex");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(ready()).toBe(false);
});

it("retains successful validation through the existing trust workflow", async () => {
  const untrusted = profiles.map((profile) => ({ ...profile, trusted: false }));
  vi.mocked(api).mockImplementation(
    (path) =>
      Promise.resolve(
        path.endsWith("/validate") ? validation : untrusted[0],
      ) as never,
  );
  await render("codex", untrusted);
  await act(async () => button("Сохранить и проверить").click());
  expect(ready()).toBe(false);
  expect(button("Доверять этой команде").disabled).toBe(false);
  await act(async () => button("Доверять этой команде").click());
  expect(api).toHaveBeenCalledWith("/api/agent-profiles/codex/trust", {
    method: "POST",
  });
  await render("codex");
  expect(ready()).toBe(true);
});

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
