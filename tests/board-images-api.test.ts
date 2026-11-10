import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app";
import { backupWorkspace, restoreWorkspace } from "../src/server/maintenance";
import { removeDatasetSchema } from "./helpers/legacy-workspace";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6mQAAAAASUVORK5CYII=";
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function open(dataDir?: string) {
  const root = mkdtempSync(join(tmpdir(), "miracle-board-image-"));
  roots.push(root);
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  const app = await buildApp({
    dataDir: dataDir ?? join(root, "data"),
    projectRoot: root,
    appOrigin: "http://127.0.0.1:3039",
    serveStatic: false,
  });
  apps.push(app);
  const session = await app.inject({
    url: "/api/session",
    headers: { host: "127.0.0.1:3039" },
  });
  const headers = {
    host: "127.0.0.1:3039",
    cookie: String(session.headers["set-cookie"]).split(";")[0],
    "x-csrf-token": session.json().csrfToken,
  };
  const upload = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/board-images", headers, payload });
  return { app, root, headers, upload };
}
const input = {
  name: "pixel.png",
  mimeType: "image/png",
  dataUrl: `data:image/png;base64,${png}`,
};
it("stores immutable binary images outside board documents and restores them with a workspace backup", async () => {
  const { app, root, headers, upload } = await open();
  const uploaded = await upload(input);
  expect(uploaded.statusCode).toBe(200);
  const image = uploaded.json();
  expect(image.id).toMatch(/^[a-f0-9]{64}$/);
  expect(image).not.toHaveProperty("dataUrl");
  expect((await upload(input)).json().id).toBe(image.id);
  const saved = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers,
    payload: {
      name: "Image board",
      document: {
        schemaVersion: 1,
        edges: [],
        nodes: [
          {
            id: "image",
            type: "artifact",
            position: { x: 0, y: 0 },
            data: { kind: "image", title: "Pixel", image },
          },
        ],
      },
    },
  });
  expect(saved.statusCode).toBe(201);
  expect(JSON.stringify(saved.json())).not.toContain(png);
  const read = await app.inject({
    url: `/api/board-images/${image.id}`,
    headers,
  });
  expect(read.headers["content-type"]).toBe("image/png");
  expect(read.headers["x-content-type-options"]).toBe("nosniff");
  expect(read.rawPayload).toEqual(Buffer.from(png, "base64"));
  await app.close();
  await backupWorkspace(join(root, "data"), join(root, "backup"));
  await restoreWorkspace(join(root, "backup"), join(root, "restored"));
  const restored = await open(join(root, "restored"));
  const again = await restored.app.inject({
    url: `/api/board-images/${image.id}`,
    headers: restored.headers,
  });
  expect(again.rawPayload).toEqual(read.rawPayload);
  expect(
    restored.app.miracle.db.query("SELECT count(*) AS count FROM board_images")
      .rows[0].count,
  ).toBe(1);
});
it("rejects forged, oversized and active image uploads and missing references", async () => {
  const { app, headers, upload } = await open();
  for (const payload of [
    { ...input, dataUrl: "data:image/png;base64,SGVsbG8=" },
    {
      ...input,
      mimeType: "image/svg+xml",
      dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    },
    {
      ...input,
      dataUrl: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")}`,
    },
    { ...input, dataUrl: `data:image/png;base64,${png.slice(0, -4)}` },
  ])
    expect((await upload(payload)).statusCode).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/board-images",
        headers: { host: headers.host },
        payload: input,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/boards",
        headers,
        payload: {
          name: "missing",
          document: {
            schemaVersion: 1,
            edges: [],
            nodes: [
              {
                id: "image",
                type: "artifact",
                position: { x: 0, y: 0 },
                data: {
                  kind: "image",
                  title: "Missing",
                  image: {
                    id: "a".repeat(64),
                    name: "missing.png",
                    mimeType: "image/png",
                    size: 1,
                  },
                },
              },
            ],
          },
        },
      })
    ).statusCode,
  ).toBe(400);
});
it("migrates an existing version 7 workspace without altering its boards", async () => {
  const { app, root } = await open();
  app.miracle.db.query(
    "INSERT INTO boards(id,name,document) VALUES('old','Before',?1)",
    [{ schemaVersion: 1, nodes: [], edges: [] }],
  );
  removeDatasetSchema(app.miracle.db);
  app.miracle.db.sqlite.exec(
    "DROP TABLE IF EXISTS board_images; PRAGMA user_version=7;",
  );
  await app.close();
  const migrated = await open(join(root, "data"));
  expect(
    migrated.app.miracle.db.query("SELECT name FROM boards WHERE id='old'")
      .rows[0].name,
  ).toBe("Before");
  expect(
    migrated.app.miracle.db.query("SELECT count(*) AS count FROM board_images")
      .rows[0].count,
  ).toBe(0);
});
