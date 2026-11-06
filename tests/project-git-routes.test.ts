import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore, problem } from "../src/server/project-store";
import { registerProjectGitRoutes } from "../src/server/project-git-routes";
import { assertProjectGitIdle, ProjectGit } from "../src/server/project-git";

const binary =
  process.platform === "darwin" &&
  existsSync("/Library/Developer/CommandLineTools/usr/bin/git")
    ? "/Library/Developer/CommandLineTools/usr/bin/git"
    : "git";
let root: string,
  repo: string,
  store: ProjectStore,
  db: Database,
  app: ReturnType<typeof Fastify>;
const git = (...args: string[]) =>
  execFileSync(binary, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const request = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    payload: payload as object,
    headers: { "x-test-auth": "yes" },
  });
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-git-routes-")));
  repo = join(root, "project");
  mkdirSync(repo);
  const dataDir = join(root, "state");
  mkdirSync(dataDir);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("config", "core.hooksPath", ".git/hooks");
  git("config", "commit.gpgSign", "false");
  writeFileSync(join(repo, "file.sql"), "select 1\n");
  git("add", ".");
  git("commit", "-m", "initial");
  vi.stubEnv("MIRACLE_GIT_BINARY", binary);
  db = new Database(dataDir);
  migrate(db, () => {});
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: repo,
    dataDir,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  app = Fastify();
  registerProjectGitRoutes(app, store, (req) => {
    if (req.headers["x-test-auth"] !== "yes")
      throw problem(401, "Unauthorized");
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  store.close();
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("authenticates all Git endpoints and leaves the repository unchanged", async () => {
  for (const [method, url] of [
    ["GET", "/api/project/git"],
    ["GET", "/api/project/git/diff?path=file.sql"],
    ["POST", "/api/project/git/branches"],
    ["POST", "/api/project/git/switch"],
    ["POST", "/api/project/git/commit"],
  ] as const) {
    expect(
      (
        await app.inject({
          method,
          url,
          payload: method === "POST" ? {} : undefined,
        })
      ).statusCode,
    ).toBe(401);
  }
  expect(git("branch", "--show-current").trim()).toBe("main");
});

it("returns fresh Git state and emits an action event after each successful mutation", async () => {
  const initial = (await request("GET", "/api/project/git")).json();
  const created = await request("POST", "/api/project/git/branches", {
    name: "feature",
    revision: initial.revision,
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().branch).toBe("feature");
  const switched = await request("POST", "/api/project/git/switch", {
    branch: "main",
    revision: created.json().revision,
  });
  expect(switched.statusCode).toBe(200);
  writeFileSync(join(repo, "file.sql"), "select 2\n");
  const status = (await request("GET", "/api/project/git")).json();
  expect(
    (await request("GET", "/api/project/git/diff?path=file.sql")).json().patch,
  ).toContain("+select 2");
  const committed = await request("POST", "/api/project/git/commit", {
    paths: ["file.sql"],
    message: "SQL",
    revision: status.revision,
  });
  expect(committed.statusCode).toBe(200);
  expect(committed.json().files).toEqual([]);
  expect(
    store.since(0).map((e) => (e.data as { action: string }).action),
  ).toEqual(["create_branch", "switch", "commit"]);
  expect(store.since(0).every((e) => e.type === "git.changed")).toBe(true);
});

it("blocks Git writes while an agent is active, including the status explanation", async () => {
  const id = randomUUID(),
    time = new Date().toISOString();
  db.query("INSERT INTO agent_profiles VALUES(?1,'test','codex','unused',?2)", [
    id,
    time,
  ]);
  db.query(
    "INSERT INTO agent_chats(id,title,profile_id,provider,created_at,updated_at) VALUES(?1,'test',?1,'codex',?2,?2)",
    [id, time],
  );
  db.query(
    "INSERT INTO agent_turns(id,chat_id,request_id,status,context_json,created_at) VALUES(?1,?1,?1,'running','{}',?2)",
    [id, time],
  );
  const status = (await request("GET", "/api/project/git")).json();
  expect(status.canMutate).toBe(false);
  expect(status.mutationBlockedReason).toContain("агент");
  for (const [url, body] of [
    ["branches", { name: "new" }],
    ["switch", { branch: "main" }],
    ["commit", { paths: ["file.sql"], message: "bad" }],
  ] as const) {
    const response = await request("POST", `/api/project/git/${url}`, {
      ...body,
      revision: status.revision,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("GIT_AGENT_ACTIVE");
  }
  expect(store.since(0)).toEqual([]);
});

it("reserves a project synchronously while Git mutations are pending and releases on failure", async () => {
  const service = new ProjectGit(store.context);
  const operation = service.createBranch({ name: "no", revision: "stale" });
  expect(() => assertProjectGitIdle(store.context)).toThrow(
    expect.objectContaining({ code: "GIT_BUSY" }),
  );
  await expect(operation).rejects.toMatchObject({ code: "GIT_STALE" });
  expect(() => assertProjectGitIdle(store.context)).not.toThrow();
});
