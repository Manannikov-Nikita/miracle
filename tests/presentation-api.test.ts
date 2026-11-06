import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import type { Board } from "../src/shared/types";

it("uses the authenticated board API for presentation creation, filtering and slide operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "miracle-presentation-api-"));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp({
      projectRoot: root,
      dataDir: join(root, ".miracle"),
      serveStatic: false,
      appOrigin: "http://127.0.0.1:5178",
    });
    const host = "127.0.0.1:5178";
    const session = await app.inject({
      url: "/api/session",
      headers: { host },
    });
    const headers = {
      host,
      origin: `http://${host}`,
      cookie: String(session.headers["set-cookie"]).split(";")[0],
      "x-csrf-token": session.json().csrfToken,
    };
    const board = await app.inject({
      method: "POST",
      url: "/api/boards",
      headers,
      payload: { name: "Board" },
    });
    expect(board.statusCode, board.body).toBe(201);
    const created = await app.inject({
      method: "POST",
      url: "/api/boards",
      headers,
      payload: { name: "Deck", kind: "presentation" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, revision, document } = created.json<Board>();
    expect(document.kind).toBe("presentation");
    expect(document.slides).toHaveLength(1);
    for (const [kind, expectedId] of [
      ["board", board.json().id],
      ["presentation", id],
    ]) {
      const list = await app.inject({
        url: `/api/boards?kind=${kind}`,
        headers,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json()).toMatchObject([{ id: expectedId, kind }]);
    }
    const invalid = await app.inject({
      url: "/api/boards?kind=unknown",
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/boards/${id}`,
      headers,
      payload: {
        baseRevision: revision,
        mutationId: randomUUID(),
        operations: [
          {
            type: "add_slide",
            slide: { id: "next", title: "Next", background: "#112233" },
          },
        ],
      },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json<Board>().document.slides).toMatchObject([
      { id: document.slides?.[0].id },
      { id: "next", title: "Next", background: "#112233" },
    ]);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
