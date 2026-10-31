// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe("client instance-bound local session", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());
  it("binds JSON requests and fetch-SSE to the opened workspace and server instance", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          workspaceId: "workspace",
          instanceId: "instance",
          csrfToken: "csrf",
        }),
      )
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(
        new Response(": alive\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const { openLocalSession, api, openEventStream } =
      await import("../src/client/api");
    await openLocalSession();
    await api("/api/chats", { method: "POST", body: "{}" });
    await openEventStream(19, new AbortController().signal);
    for (const call of fetch.mock.calls.slice(1)) {
      const headers = call[1].headers as Headers;
      expect(headers.get("X-Miracle-Workspace")).toBe("workspace");
      expect(headers.get("X-Miracle-Instance")).toBe("instance");
    }
    expect(
      (fetch.mock.calls[1][1].headers as Headers).get("X-CSRF-Token"),
    ).toBe("csrf");
    expect(fetch.mock.calls[2][0]).toBe("/api/events?after=19");
  });
  it("refuses to replay into a new server instance after a session refresh", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          workspaceId: "workspace",
          instanceId: "first",
          csrfToken: "csrf",
        }),
      )
      .mockResolvedValueOnce(response({ error: "Stale" }, 401))
      .mockResolvedValueOnce(
        response({
          workspaceId: "workspace",
          instanceId: "second",
          csrfToken: "csrf2",
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const { openLocalSession, api } = await import("../src/client/api");
    await openLocalSession();
    await expect(api("/api/editor-documents")).rejects.toMatchObject({
      code: "WORKSPACE_CHANGED",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
