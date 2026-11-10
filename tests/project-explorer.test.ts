import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as files from "../src/server/project-files";
import { registerProjectRoutes } from "../src/server/project-routes";
import { problem, ProjectStore } from "../src/server/project-store";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";

let root: string, project: string, dataDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-explorer-")));
  project = join(root, "project");
  dataDir = join(project, "private-state");
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const context = () => ({ projectRoot: project, dataDir });
function routeStore(app: ReturnType<typeof Fastify>) {
  const db = new Database(dataDir);
  migrate(db, () => {});
  const store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    ...context(),
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  app.addHook("onClose", async () => {
    store.close();
    db.close();
  });
  return store;
}
const file = (name: string, content: string | Buffer = "hello") => {
  const path = join(project, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};

it("creates folders in the selected parent and never replaces existing entries", async () => {
  expect(
    files.createProjectDirectory(context(), { directory: "", name: "docs" }),
  ).toEqual({
    path: "docs",
    name: "docs",
    kind: "directory",
  });
  files.createProjectDirectory(context(), {
    directory: "docs",
    name: "Заметки",
  });
  expect((await files.listProjectTree(context(), "docs")).entries).toEqual([
    { path: "docs/Заметки", name: "Заметки", kind: "directory" },
  ]);
  file("existing.txt", "keep");
  for (const name of ["docs", "existing.txt"])
    expect(() =>
      files.createProjectDirectory(context(), { directory: "", name }),
    ).toThrow(
      expect.objectContaining({ statusCode: 409, code: "FILE_ALREADY_EXISTS" }),
    );
  expect(readFileSync(join(project, "existing.txt"), "utf8")).toBe("keep");
});

it("moves regular files between folders and root without changing bytes or permissions", () => {
  const bytes = Buffer.from([0, 255, 17, 5]);
  const original = file("docs/image.bin", bytes);
  chmodSync(original, 0o640);
  const moved = files.moveProjectFile(context(), {
    path: "docs/image.bin",
    directory: "",
  });
  expect(moved).toEqual({
    from: "docs/image.bin",
    path: "image.bin",
    name: "image.bin",
  });
  expect(existsSync(original)).toBe(false);
  expect(readFileSync(join(project, "image.bin"))).toEqual(bytes);
  expect(statSync(join(project, "image.bin")).mode & 0o777).toBe(0o640);
  files.moveProjectFile(context(), { path: "image.bin", directory: "docs" });
  expect(readFileSync(original)).toEqual(bytes);
});

it("keeps both paths intact when a move destination already exists", () => {
  file("source/a.txt", "source");
  file("target/a.txt", "target");
  expect(() =>
    files.moveProjectFile(context(), {
      path: "source/a.txt",
      directory: "target",
    }),
  ).toThrow(
    expect.objectContaining({ statusCode: 409, code: "FILE_ALREADY_EXISTS" }),
  );
  expect(readFileSync(join(project, "source/a.txt"), "utf8")).toBe("source");
  expect(readFileSync(join(project, "target/a.txt"), "utf8")).toBe("target");
  rmSync(join(project, "target/a.txt"));
  symlinkSync(join(root, "missing"), join(project, "target/a.txt"));
  expect(() =>
    files.moveProjectFile(context(), {
      path: "source/a.txt",
      directory: "target",
    }),
  ).toThrow();
  expect(readFileSync(join(project, "source/a.txt"), "utf8")).toBe("source");
  expect(existsSync(join(root, "missing"))).toBe(false);
});

it("rejects directory creation and moves through private paths, traversal and links", () => {
  file("notes.txt", "keep");
  mkdirSync(join(project, ".git"));
  mkdirSync(join(project, ".codegraph"));
  symlinkSync(root, join(project, "alias"));
  symlinkSync(join(project, "notes.txt"), join(project, "link.txt"));
  for (const directory of [
    "..",
    ".git",
    ".codegraph",
    "private-state",
    "alias",
  ])
    for (const operation of [
      () => files.createProjectDirectory(context(), { directory, name: "new" }),
      () => files.moveProjectFile(context(), { path: "notes.txt", directory }),
    ])
      expect(operation).toThrow();
  for (const name of [
    "..",
    "a/b",
    ".git",
    ".miracle",
    ".codegraph",
    "node_modules",
  ])
    expect(() =>
      files.createProjectDirectory(context(), { directory: "", name }),
    ).toThrow();
  expect(() =>
    files.moveProjectFile(context(), { path: "link.txt", directory: "" }),
  ).toThrow();
  expect(() =>
    files.moveProjectFile(context(), { path: ".git", directory: "" }),
  ).toThrow();
  expect(readFileSync(join(project, "notes.txt"), "utf8")).toBe("keep");
});

it("authenticates folder creation and protects both move paths from agent work", async () => {
  file("notes.txt", "keep");
  const app = Fastify();
  const store = routeStore(app);
  registerProjectRoutes(app, store, (request) => {
    if (request.headers["x-test-session"] !== "allowed")
      throw problem(401, "Session required");
  });
  const headers = { "x-test-session": "allowed" };
  try {
    const folder = {
      method: "POST" as const,
      url: "/api/project/directory",
      payload: { directory: "", name: "docs" },
    };
    expect((await app.inject(folder)).statusCode).toBe(401);
    store.work.runAs(
      { turnId: "folder-turn", chatId: "test-chat", isActive: () => true },
      () => store.work.begin([{ kind: "file", id: "docs" }]),
    );
    expect((await app.inject({ ...folder, headers })).statusCode).toBe(423);
    expect(existsSync(join(project, "docs"))).toBe(false);
    store.work.releaseTurn("folder-turn");
    expect((await app.inject({ ...folder, headers })).statusCode).toBe(201);
    expect((await app.inject({ ...folder, headers })).statusCode).toBe(409);
    const move = {
      method: "POST" as const,
      url: "/api/project/file/move",
      payload: { path: "notes.txt", directory: "docs" },
    };
    expect((await app.inject(move)).statusCode).toBe(401);
    for (const path of ["notes.txt", "docs/notes.txt"]) {
      store.work.runAs(
        { turnId: "test-turn", chatId: "test-chat", isActive: () => true },
        () => store.work.begin([{ kind: "file", id: path }]),
      );
      expect((await app.inject({ ...move, headers })).statusCode).toBe(423);
      expect(existsSync(join(project, "notes.txt"))).toBe(true);
      store.work.releaseTurn("test-turn");
    }
    expect((await app.inject({ ...move, headers })).json()).toEqual({
      from: "notes.txt",
      path: "docs/notes.txt",
      name: "notes.txt",
    });
    expect(readFileSync(join(project, "docs/notes.txt"), "utf8")).toBe("keep");
  } finally {
    await app.close();
  }
});

it("creates empty files in the chosen directory with the exact user-supplied filename", () => {
  mkdirSync(join(project, "docs"));
  for (const input of [
    { directory: "", name: "README" },
    { directory: "docs", name: "Мой отчёт.sql" },
    { directory: "docs", name: ".notes.md" },
  ]) {
    const created = files.createProjectFile(context(), input);
    const path = input.directory
      ? `${input.directory}/${input.name}`
      : input.name;
    expect(created).toMatchObject({
      path,
      name: input.name,
      content: "",
      size: 0,
    });
    expect(created.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(project, path), "utf8")).toBe("");
    const saved = files.saveProjectFile(context(), path, {
      content: "first edit",
      baseRevision: created.revision,
    });
    expect(saved.content).toBe("first edit");
  }
});

it("never replaces existing files, folders or links while creating a file", () => {
  file("existing.txt", "keep this content");
  mkdirSync(join(project, "folder"));
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside content");
  symlinkSync(outside, join(project, "alias.txt"));
  symlinkSync(join(root, "not-created.txt"), join(project, "broken.txt"));
  for (const name of ["existing.txt", "folder", "alias.txt", "broken.txt"])
    expect(() =>
      files.createProjectFile(context(), { directory: "", name }),
    ).toThrow(
      expect.objectContaining({ statusCode: 409, code: "FILE_ALREADY_EXISTS" }),
    );
  expect(readFileSync(join(project, "existing.txt"), "utf8")).toBe(
    "keep this content",
  );
  expect(readFileSync(outside, "utf8")).toBe("outside content");
  expect(existsSync(join(root, "not-created.txt"))).toBe(false);
});

it("rejects invalid names and keeps creation inside accessible project directories", () => {
  file(".git/config");
  file("node_modules/package/index.js");
  mkdirSync(join(project, ".miracle"));
  mkdirSync(join(project, ".codegraph"));
  symlinkSync(root, join(project, "escape-dir"));
  for (const name of [
    "",
    " ",
    ".",
    "..",
    "../escape.txt",
    "nested/file.txt",
    "nested\\file.txt",
    "bad\u0000.txt",
    "bad\n.txt",
    "a".repeat(256),
    "я".repeat(128),
    "notes:stream",
    "bad\ud800.txt",
  ])
    expect(
      () => files.createProjectFile(context(), { directory: "", name }),
      name,
    ).toThrow(
      expect.objectContaining({ statusCode: 400, code: "INVALID_FILE_NAME" }),
    );
  for (const directory of [
    "..",
    root,
    ".git",
    ".miracle",
    ".codegraph",
    "private-state",
    "node_modules",
    "escape-dir",
    "missing",
  ])
    expect(
      () => files.createProjectFile(context(), { directory, name: "new.txt" }),
      directory,
    ).toThrow();
  for (const name of [".git", ".GIT", ".miracle", ".MIRACLE"])
    expect(
      () => files.createProjectFile(context(), { directory: "", name }),
      name,
    ).toThrow();
  expect(existsSync(join(root, "new.txt"))).toBe(false);
  expect(existsSync(join(dataDir, "new.txt"))).toBe(false);
});

it("requires authentication to create files and returns a reusable file document", async () => {
  mkdirSync(join(project, "docs"));
  const app = Fastify();
  registerProjectRoutes(app, routeStore(app), (request) => {
    if (request.headers["x-test-session"] !== "allowed")
      throw problem(401, "Session required");
  });
  const request = {
    method: "POST" as const,
    url: "/api/project/file",
    payload: { directory: "docs", name: "new.json" },
  };
  try {
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(existsSync(join(project, "docs/new.json"))).toBe(false);
    const headers = { "x-test-session": "allowed" };
    const created = await app.inject({ ...request, headers });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      path: "docs/new.json",
      name: "new.json",
      content: "",
      size: 0,
    });
    const duplicate = await app.inject({ ...request, headers });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("FILE_ALREADY_EXISTS");
    expect(
      (
        await app.inject({
          ...request,
          headers,
          payload: { directory: "docs", name: "../escape.json" },
        })
      ).statusCode,
    ).toBe(400);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/project/file?path=docs%2Fnew.json",
      headers,
      payload: { content: "{}", baseRevision: created.json().revision },
    });
    expect(saved.statusCode).toBe(200);
    expect(readFileSync(join(project, "docs/new.json"), "utf8")).toBe("{}");
  } finally {
    await app.close();
  }
});

it("lists one level with directories first and keeps internal and generated trees private", async () => {
  file("sql/Отчёт.sql", "SELECT 42;");
  file("README.md");
  file(".notes.md");
  for (const name of [
    ".miracle/key",
    ".git/config",
    "private-state/database.sqlite",
    "node_modules/pkg/index.js",
    "dist/bundle.js",
  ])
    file(name);
  const listing = await files.listProjectTree(context(), "");
  expect(listing).toMatchObject({ path: "", truncated: false });
  expect(listing.entries.map(({ path, kind }) => ({ path, kind }))).toEqual([
    { path: "sql", kind: "directory" },
    { path: ".notes.md", kind: "file" },
    { path: "README.md", kind: "file" },
  ]);
  expect(await files.listProjectTree(context(), "sql")).toEqual({
    path: "sql",
    entries: [
      { path: "sql/Отчёт.sql", name: "Отчёт.sql", kind: "file", size: 10 },
    ],
    truncated: false,
  });
});

it("reads UTF-8 text and saves against its revision while preserving file permissions", () => {
  const path = file("docs/Привет.md", "# Привет\r\n");
  chmodSync(path, 0o640);
  const original = files.readProjectFile(context(), "docs/Привет.md");
  expect(original).toMatchObject({
    path: "docs/Привет.md",
    name: "Привет.md",
    content: "# Привет\r\n",
    size: Buffer.byteLength("# Привет\r\n"),
  });
  expect(original.revision).toMatch(/^[0-9a-f]{64}$/);
  const saved = files.saveProjectFile(context(), original.path, {
    content: "# Изменено\n",
    baseRevision: original.revision,
  });
  expect(readFileSync(path, "utf8")).toBe("# Изменено\n");
  expect(saved.content).toBe("# Изменено\n");
  expect(saved.revision).not.toBe(original.revision);
  expect(statSync(path).mode & 0o777).toBe(0o640);
});

it("rejects stale saves after another editor changes a file without overwriting that change", () => {
  const path = file("notes.txt", "first");
  const original = files.readProjectFile(context(), "notes.txt");
  writeFileSync(path, "changed elsewhere");
  expect(() =>
    files.saveProjectFile(context(), original.path, {
      content: "local draft",
      baseRevision: original.revision,
    }),
  ).toThrow(
    expect.objectContaining({
      statusCode: 409,
      code: "FILE_REVISION_CONFLICT",
    }),
  );
  expect(readFileSync(path, "utf8")).toBe("changed elsewhere");
});

it("saves long filenames and preserves UTF-8 byte order marks", () => {
  const name = `${"a".repeat(240)}.txt`;
  const path = file(name, "\ufeffhello\r\n");
  const original = files.readProjectFile(context(), name);
  files.saveProjectFile(context(), name, {
    content: original.content,
    baseRevision: original.revision,
  });
  expect(readFileSync(path)).toEqual(Buffer.from("\ufeffhello\r\n", "utf8"));
});

it("does not read or save binary, corrupt UTF-8, or oversized files", () => {
  file("image.bin", Buffer.from([0, 1, 2, 3]));
  file("invalid.txt", Buffer.from([0xc3, 0x28]));
  file("large.txt", Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  for (const path of ["image.bin", "invalid.txt"])
    expect(() => files.readProjectFile(context(), path)).toThrow(
      expect.objectContaining({ statusCode: 415, code: "FILE_NOT_TEXT" }),
    );
  expect(() => files.readProjectFile(context(), "large.txt")).toThrow(
    expect.objectContaining({ statusCode: 413, code: "FILE_TOO_LARGE" }),
  );
  const path = file("notes.txt", "unchanged");
  const { revision } = files.readProjectFile(context(), "notes.txt");
  expect(() =>
    files.saveProjectFile(context(), "notes.txt", {
      content: "я".repeat(1024 * 1024 + 1),
      baseRevision: revision,
    }),
  ).toThrow(expect.objectContaining({ statusCode: 413 }));
  expect(() =>
    files.saveProjectFile(context(), "notes.txt", {
      content: "bad\u0000content",
      baseRevision: revision,
    }),
  ).toThrow(expect.objectContaining({ statusCode: 415 }));
  expect(readFileSync(path, "utf8")).toBe("unchanged");
});

it("blocks traversal, directory files, internal data, and symbolic links for explorer reads and writes", async () => {
  file("visible.txt");
  file(".git/config");
  file("private-state/key");
  file("node_modules/pkg.js");
  writeFileSync(join(root, "outside.txt"), "outside");
  symlinkSync(join(root, "outside.txt"), join(project, "escape.txt"));
  symlinkSync(root, join(project, "escape-dir"));
  symlinkSync(join(project, "visible.txt"), join(project, "alias.txt"));
  for (const path of [
    "../outside.txt",
    join(root, "outside.txt"),
    "./visible.txt",
    "",
    "visible.txt\u0000",
    "escape.txt",
    "escape-dir/outside.txt",
    "alias.txt",
    ".git/config",
    "private-state/key",
    "node_modules/pkg.js",
    "missing.txt",
    "private-state",
  ]) {
    expect(() => files.readProjectFile(context(), path), path).toThrow();
    expect(
      () =>
        files.saveProjectFile(context(), path, {
          content: "overwritten",
          baseRevision: "0".repeat(64),
        }),
      path,
    ).toThrow();
  }
  for (const path of [
    "..",
    "escape-dir",
    ".git",
    "private-state",
    "node_modules",
    "visible.txt",
  ])
    await expect(
      files.listProjectTree(context(), path),
      path,
    ).rejects.toThrow();
  expect(
    (await files.listProjectTree(context(), "")).entries.map(
      (entry) => entry.path,
    ),
  ).toEqual(["visible.txt"]);
  expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("outside");
});

it("bounds a large directory and reports that the result is incomplete", async () => {
  file("a.txt");
  file("b.txt");
  file("c.txt");
  const listing = await files.listProjectTree(context(), "", { maxEntries: 2 });
  expect(listing.entries.length).toBeLessThanOrEqual(2);
  expect(listing.truncated).toBe(true);
});

it("blocks internal directories through case aliases on case-insensitive filesystems", async () => {
  file(".git/config", "private git data");
  file("private-state/key", "private application data");
  for (const path of [".GIT/config", "PRIVATE-STATE/key"]) {
    try {
      statSync(join(project, path));
    } catch {
      // The alias does not exist on case-sensitive filesystems.
      continue;
    }
    expect(() => files.readProjectFile(context(), path), path).toThrow();
    await expect(
      files.listProjectTree(context(), path.split("/")[0]),
    ).rejects.toThrow();
  }
});

it("exposes authenticated listing, read and revision-checked save routes without changing file suggestions", async () => {
  const path = file("notes.txt", "before");
  file("blob.bin", Buffer.from([0, 1]));
  const app = Fastify();
  registerProjectRoutes(app, routeStore(app), (request) => {
    if (request.headers["x-test-session"] !== "allowed")
      throw problem(401, "Session required");
  });
  const headers = { "x-test-session": "allowed" };
  try {
    for (const url of ["/api/project/tree", "/api/project/file?path=notes.txt"])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/project/file?path=notes.txt",
          payload: { content: "denied", baseRevision: "0".repeat(64) },
        })
      ).statusCode,
    ).toBe(401);
    const tree = await app.inject({ url: "/api/project/tree", headers });
    expect(tree.statusCode).toBe(200);
    expect(
      tree.json().entries.map((entry: { path: string }) => entry.path),
    ).toEqual(["blob.bin", "notes.txt"]);
    const opened = await app.inject({
      url: "/api/project/file?path=notes.txt",
      headers,
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().content).toBe("before");
    const payload = { content: "after", baseRevision: opened.json().revision };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/project/file?path=notes.txt",
      headers,
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().content).toBe("after");
    expect(readFileSync(path, "utf8")).toBe("after");
    const stale = await app.inject({
      method: "PUT",
      url: "/api/project/file?path=notes.txt",
      headers,
      payload,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("FILE_REVISION_CONFLICT");
    expect(
      (await app.inject({ url: "/api/project/file?path=blob.bin", headers }))
        .statusCode,
    ).toBe(415);
    expect(
      (await app.inject({ url: "/api/project/files?q=notes", headers })).json(),
    ).toEqual({ files: ["notes.txt"], truncated: false });
  } finally {
    await app.close();
  }
});
