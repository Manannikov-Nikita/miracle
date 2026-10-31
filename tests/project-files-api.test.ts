import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function open(port: number, name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-file-api-")));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, name), "file contents are not listed");
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  const origin = `http://127.0.0.1:${port}`;
  const app = await buildApp({
    projectRoot: project,
    dataDir: join(project, ".miracle"),
    appOrigin: origin,
    serveStatic: false,
  });
  apps.push(app);
  const response = await app.inject({
    url: "/api/session",
    headers: { host: `127.0.0.1:${port}` },
  });
  const session = response.json();
  const headers = {
    host: `127.0.0.1:${port}`,
    origin,
    cookie: String(response.headers["set-cookie"]).split(";")[0],
    "x-miracle-instance": session.instanceId,
    "x-miracle-workspace": session.workspaceId,
  };
  return { app, headers };
}

it("authenticates file suggestions and isolates project, instance, Host and Origin", async () => {
  const first = await open(3031, "first file.sql");
  const second = await open(3032, "second.sql");
  const response = await first.app.inject({
    url: "/api/project/files?q=first",
    headers: first.headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    files: ["first file.sql"],
    truncated: false,
  });
  expect(
    (
      await second.app.inject({
        url: "/api/project/files",
        headers: second.headers,
      })
    ).json(),
  ).toEqual({ files: ["second.sql"], truncated: false });
  for (const headers of [
    { host: first.headers.host },
    { ...first.headers, origin: "https://foreign.example" },
    { ...first.headers, host: "foreign.example" },
    {
      ...first.headers,
      "x-miracle-instance": second.headers["x-miracle-instance"],
    },
    {
      ...first.headers,
      "x-miracle-workspace": second.headers["x-miracle-workspace"],
    },
    { ...first.headers, cookie: second.headers.cookie },
  ])
    expect(
      (await first.app.inject({ url: "/api/project/files", headers }))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await first.app.inject({
        url: `/api/project/files?q=${"a".repeat(201)}`,
        headers: first.headers,
      })
    ).statusCode,
  ).toBe(400);
});
