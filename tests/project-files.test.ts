import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  searchProjectFiles,
  validateProjectFiles,
} from "../src/server/project-files";

let root: string, project: string, dataDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-file-references-")));
  project = join(root, "project");
  dataDir = join(project, "private-state");
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const file = (name: string, content = "not automatically read") => {
  const path = join(project, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const context = () => ({ projectRoot: project, dataDir });

it("searches project-relative paths including spaces, Unicode, folders and ordinary dotfiles", async () => {
  file("AGENTS.md");
  file("sql/Отчёт за месяц.sql");
  file(".notes.md");
  expect(await searchProjectFiles(context(), "sql/отчёт")).toEqual({
    files: ["sql/Отчёт за месяц.sql"],
    truncated: false,
  });
  expect((await searchProjectFiles(context(), "")).files).toEqual([
    ".notes.md",
    "AGENTS.md",
    "sql/Отчёт за месяц.sql",
  ]);
  expect(
    validateProjectFiles(context(), [
      "sql/Отчёт за месяц.sql",
      "AGENTS.md",
      "AGENTS.md",
    ]),
  ).toEqual(["sql/Отчёт за месяц.sql", "AGENTS.md"]);
});

it("does not suggest internal state or dependencies, and cannot follow symlinks outside the project", async () => {
  file("visible.txt");
  for (const name of [
    ".miracle/key",
    ".git/config",
    "private-state/database.sqlite",
    "node_modules/pkg/index.js",
    "dist/bundle.js",
  ])
    file(name);
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(project, "escape.txt"));
  symlinkSync(root, join(project, "escape-directory"));
  symlinkSync(join(project, "visible.txt"), join(project, "alias.txt"));
  symlinkSync(dataDir, join(project, "state-alias"));
  symlinkSync(
    join(dataDir, "database.sqlite"),
    join(project, "state-alias.sqlite"),
  );
  expect((await searchProjectFiles(context(), "")).files).toEqual([
    "alias.txt",
    "visible.txt",
  ]);
  expect(validateProjectFiles(context(), ["alias.txt"])).toEqual(["alias.txt"]);
  for (const path of [
    "../outside.txt",
    outside,
    "escape.txt",
    "escape-directory/outside.txt",
    "state-alias/database.sqlite",
    "state-alias.sqlite",
    ".miracle/key",
    ".git/config",
    "private-state/database.sqlite",
    "missing",
    "sql/../visible.txt",
    "./visible.txt",
    "visible.txt\u0000",
  ])
    expect(() => validateProjectFiles(context(), [path]), path).toThrow();
  expect(() => validateProjectFiles(context(), ["node_modules"])).toThrow();
});

it("bounds suggestions and scanning without claiming an exhaustive result", async () => {
  for (let i = 0; i < 45; i++) file(`query-${String(i).padStart(2, "0")}.sql`);
  const result = await searchProjectFiles(context(), "query");
  expect(result.files).toHaveLength(40);
  expect(result.truncated).toBe(true);
  expect(await searchProjectFiles(context(), "query-44")).toEqual({
    files: ["query-44.sql"],
    truncated: false,
  });
  expect(
    await searchProjectFiles(context(), "absent", { maxEntries: 10 }),
  ).toEqual({ files: [], truncated: true });
});

it("keeps independent project roots separate and rejects references removed after selection", async () => {
  const selected = file("first.txt");
  const second = join(root, "second");
  mkdirSync(second);
  writeFileSync(join(second, "second.txt"), "second");
  expect(
    (
      await searchProjectFiles(
        { projectRoot: second, dataDir: join(second, ".miracle") },
        "",
      )
    ).files,
  ).toEqual(["second.txt"]);
  expect(() =>
    validateProjectFiles(context(), ["../second/second.txt"]),
  ).toThrow();
  rmSync(selected);
  expect(() => validateProjectFiles(context(), ["first.txt"])).toThrow(
    /не найден|недоступен/,
  );
});
