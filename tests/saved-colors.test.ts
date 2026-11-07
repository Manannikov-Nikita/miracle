// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SAVED_COLORS_STORAGE_KEY,
  useSavedColors,
} from "../src/client/colors/saved-colors";

describe("personal saved colors", () => {
  let host: HTMLDivElement;
  let root: Root;
  let palette: ReturnType<typeof useSavedColors>;
  let second: ReturnType<typeof useSavedColors>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => {
      localStorage.clear();
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });
  async function mount() {
    function First() {
      palette = useSavedColors();
      return null;
    }
    function Second() {
      second = useSavedColors();
      return null;
    }
    await act(async () =>
      root.render(
        createElement("div", {}, createElement(First), createElement(Second)),
      ),
    );
  }
  async function change(operation: () => boolean) {
    let result = false;
    await act(async () => {
      result = operation();
    });
    return result;
  }
  function stored(colors: unknown[]) {
    localStorage.setItem(
      SAVED_COLORS_STORAGE_KEY,
      JSON.stringify({ version: 1, colors }),
    );
  }
  it("normalizes, persists and shares added colors between mounted consumers", async () => {
    await mount();
    expect(await change(() => palette.add("#aBc", "  Мята  "))).toBe(true);
    expect(palette.colors).toEqual([
      { id: expect.any(String), name: "Мята", color: "#AABBCC" },
    ]);
    expect(second.colors).toEqual(palette.colors);
    expect(JSON.parse(localStorage.getItem(SAVED_COLORS_STORAGE_KEY)!)).toEqual(
      { version: 1, colors: palette.colors },
    );
    const id = palette.colors[0].id;
    await act(async () => root.render(null));
    await mount();
    expect(palette.colors[0].id).toBe(id);
  });
  it("rejects duplicates and invalid colors without changing the saved palette", async () => {
    await mount();
    await change(() => palette.add("#AABBCC"));
    expect(await change(() => palette.add("#abc"))).toBe(false);
    expect(palette.error).toBeTruthy();
    expect(await change(() => palette.add("transparent"))).toBe(false);
    expect(await change(() => palette.add("#abcdxy"))).toBe(false);
    expect(palette.colors).toHaveLength(1);
    expect(palette.colors[0].name).toBe("#AABBCC");
  });
  it("edits, reorders and removes entries while preserving their identities", async () => {
    await mount();
    await change(() => palette.add("#112233", "Первый"));
    await change(() => palette.add("#445566", "Второй"));
    const [first, last] = palette.colors;
    expect(
      await change(() =>
        palette.update(first.id, { name: " Новый ", color: "#abcdef" }),
      ),
    ).toBe(true);
    expect(palette.colors[0]).toEqual({
      id: first.id,
      name: "Новый",
      color: "#ABCDEF",
    });
    expect(
      await change(() => palette.update(first.id, { color: last.color })),
    ).toBe(false);
    expect(palette.colors[0].color).toBe("#ABCDEF");
    expect(await change(() => palette.move(last.id, -1))).toBe(true);
    expect(palette.colors.map((color) => color.id)).toEqual([
      last.id,
      first.id,
    ]);
    expect(await change(() => palette.move(last.id, -1))).toBe(false);
    expect(await change(() => palette.remove(last.id))).toBe(true);
    expect(palette.colors.map((color) => color.id)).toEqual([first.id]);
    expect(
      await change(() => palette.update("missing", { name: "Lost" })),
    ).toBe(false);
  });
  it("caps the personal palette at 64 colors", async () => {
    stored(
      Array.from({ length: 64 }, (_, i) => ({
        id: `c${i}`,
        name: `Color ${i}`,
        color: `#0000${i.toString(16).padStart(2, "0")}`,
      })),
    );
    await mount();
    expect(await change(() => palette.add("#FFFFFF"))).toBe(false);
    expect(palette.colors).toHaveLength(64);
    expect(palette.error).toBeTruthy();
  });
  it("recovers valid entries from corrupt storage and reports discarded entries", async () => {
    stored([
      { id: "good", name: "Valid", color: "#abc" },
      { id: "duplicate", name: "Duplicate", color: "#AABBCC" },
      { id: "bad", name: "Bad", color: "not a color" },
      null,
    ]);
    await mount();
    expect(palette.colors).toEqual([
      { id: "good", name: "Valid", color: "#AABBCC" },
    ]);
    expect(palette.error).toBeTruthy();
    expect(
      JSON.parse(localStorage.getItem(SAVED_COLORS_STORAGE_KEY)!).colors,
    ).toHaveLength(4);
  });
  it("does not crash on malformed JSON or unexpected storage versions", async () => {
    localStorage.setItem(SAVED_COLORS_STORAGE_KEY, "{broken");
    await mount();
    expect(palette.colors).toEqual([]);
    expect(palette.error).toBeTruthy();
    await act(async () => root.render(null));
    localStorage.setItem(
      SAVED_COLORS_STORAGE_KEY,
      JSON.stringify({ version: 999, colors: [] }),
    );
    await mount();
    expect(palette.colors).toEqual([]);
    expect(palette.error).toBeTruthy();
  });
  it("reports blocked reads and never claims an addition was saved", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    await mount();
    expect(palette.error).toBeTruthy();
    expect(await change(() => palette.add("#123456"))).toBe(false);
    expect(palette.colors).toEqual([]);
  });
  it("retains the persisted palette on write failure and permits a later retry", async () => {
    await mount();
    await change(() => palette.add("#112233", "Original"));
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota", "QuotaExceededError");
      });
    expect(
      await change(() =>
        palette.update(palette.colors[0].id, { name: "Unsaved" }),
      ),
    ).toBe(false);
    expect(palette.colors[0].name).toBe("Original");
    expect(palette.error).toBeTruthy();
    write.mockRestore();
    expect(
      await change(() =>
        palette.update(palette.colors[0].id, { name: "Saved" }),
      ),
    ).toBe(true);
    expect(palette.colors[0].name).toBe("Saved");
    expect(palette.error).toBeNull();
  });
  it("delivers cross-tab changes and clear events to every mounted consumer", async () => {
    await mount();
    await act(async () => {
      stored([{ id: "external", name: "Other tab", color: "#123456" }]);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: SAVED_COLORS_STORAGE_KEY,
          storageArea: localStorage,
        }),
      );
    });
    expect(palette.colors[0].name).toBe("Other tab");
    expect(second.colors).toEqual(palette.colors);
    await act(async () => {
      localStorage.clear();
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
    });
    expect(palette.colors).toEqual([]);
    expect(second.colors).toEqual([]);
  });
  it("reads pending cross-tab changes before applying a local mutation", async () => {
    await mount();
    stored([{ id: "external", name: "Other tab", color: "#123456" }]);
    await change(() => palette.add("#ABCDEF", "Here"));
    expect(palette.colors.map((color) => color.name)).toEqual([
      "Other tab",
      "Here",
    ]);
  });
});
