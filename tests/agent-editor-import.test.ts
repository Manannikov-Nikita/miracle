// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";
import { loadEditorDocuments } from "../src/client/agents/useEditorSync";
describe("browser editor draft migration", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    });
    vi.mocked(api).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());
  it("imports only the currently opened workspace and acknowledges a server reply", async () => {
    localStorage.setItem(
      "miracle:sql-tabs:other",
      JSON.stringify([{ id: "other" }]),
    );
    localStorage.setItem(
      "miracle:sql-tabs:current",
      JSON.stringify([{ id: "mine", sql: "recover me" }]),
    );
    vi.mocked(api)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "mine" }]);
    expect(await loadEditorDocuments("current")).toEqual([{ id: "mine" }]);
    const body = JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string);
    expect(body.documents).toEqual([{ id: "mine", sql: "recover me" }]);
    expect(localStorage.getItem("miracle:sql-tabs:current:imported")).toBe("1");
    expect(localStorage.getItem("miracle:sql-tabs:other:imported")).toBeNull();
  });
  it("retains drafts after network failure and retries with the same per-browser migration id", async () => {
    localStorage.setItem(
      "miracle:sql-tabs:current",
      JSON.stringify([{ id: "mine", sql: "recover me" }]),
    );
    vi.mocked(api)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "mine" }]);
    await expect(loadEditorDocuments("current")).rejects.toThrow(
      "Connection lost",
    );
    expect(
      localStorage.getItem("miracle:sql-tabs:current:imported"),
    ).toBeNull();
    await loadEditorDocuments("current");
    const first = JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string),
      retry = JSON.parse(vi.mocked(api).mock.calls[3][1]!.body as string);
    expect(first.migrationId).toBe(retry.migrationId);
    expect(localStorage.getItem("miracle:sql-tabs:current")).toContain(
      "recover me",
    );
  });
});
