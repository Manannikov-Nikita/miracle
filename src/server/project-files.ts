import { lstatSync, realpathSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { ProjectContext } from "../shared/agents.js";
import { problem } from "./project-store.js";

type FileContext = Pick<ProjectContext, "projectRoot" | "dataDir">;
const excludedDirectories = new Set([
  ".git",
  ".miracle",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
]);
const internalNames = new Set([".git", ".miracle"]);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
};
const validRelativePath = (path: string) =>
  path.length > 0 &&
  path.length <= 4096 &&
  !isAbsolute(path) &&
  !win32.isAbsolute(path) &&
  !/[\\\u0000-\u001f\u007f]/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
function scope(context: FileContext) {
  const root = realpathSync(context.projectRoot);
  let data = resolve(context.dataDir);
  try {
    data = realpathSync(data);
  } catch {}
  const allowed = (path: string) =>
    inside(root, path) &&
    !inside(data, path) &&
    !relative(root, path)
      .split(sep)
      .some((part) => internalNames.has(part));
  return { root, allowed };
}

/** Validate paths only. Native CLI tools retain responsibility for reading files. */
export function validateProjectFiles(
  context: FileContext,
  paths: string[],
): string[] {
  if (paths.length > 20) throw problem(400, "Можно указать не более 20 файлов");
  const { root, allowed } = scope(context);
  return [...new Set(paths)].map((path) => {
    if (!validRelativePath(path))
      throw problem(
        400,
        "Нужен относительный путь к файлу проекта",
        "INVALID_FILE_REFERENCE",
      );
    const absolute = join(root, path);
    if (!allowed(absolute))
      throw problem(
        400,
        "Служебные файлы Miracle недоступны для ссылки",
        "INVALID_FILE_REFERENCE",
      );
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      throw problem(
        400,
        `Файл не найден или недоступен: ${path}`,
        "INVALID_FILE_REFERENCE",
      );
    }
    if (!allowed(real))
      throw problem(
        400,
        `Файл находится вне доступной папки проекта: ${path}`,
        "INVALID_FILE_REFERENCE",
      );
    try {
      if (!lstatSync(real).isFile()) throw new Error("Not a regular file");
    } catch {
      throw problem(
        400,
        `Нужен доступный обычный файл: ${path}`,
        "INVALID_FILE_REFERENCE",
      );
    }
    return path;
  });
}

export async function searchProjectFiles(
  context: FileContext,
  query: string,
  limits: { maxEntries?: number } = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const { root, allowed } = scope(context);
  const needle = query.normalize("NFC").toLocaleLowerCase();
  const queue = [{ path: root, relative: "", depth: 0 }];
  const files: string[] = [];
  const maxEntries = limits.maxEntries ?? 10000;
  let visited = 0,
    truncated = false;
  const compare = (a: string, b: string) => {
    const score = (value: string) => {
      const lower = value.normalize("NFC").toLocaleLowerCase();
      const name = lower.split("/").at(-1)!;
      return name === needle
        ? 0
        : name.startsWith(needle)
          ? 1
          : lower.startsWith(needle)
            ? 2
            : 3;
    };
    return score(a) - score(b) || (a < b ? -1 : a > b ? 1 : 0);
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (visited >= maxEntries) {
      truncated = true;
      break;
    }
    const directory = queue[cursor];
    try {
      // Recheck queued directories: a rename or symlink replacement must not
      // make the scanner enumerate a different project or internal storage.
      if (
        !allowed(realpathSync(directory.path)) ||
        lstatSync(directory.path).isSymbolicLink()
      )
        continue;
      const entries = await opendir(directory.path);
      for await (const entry of entries) {
        if (++visited > maxEntries) {
          truncated = true;
          break;
        }
        const rel = directory.relative
          ? `${directory.relative}/${entry.name}`
          : entry.name;
        if (!validRelativePath(rel)) continue;
        const path = join(directory.path, entry.name);
        if (!allowed(path)) continue;
        if (entry.isDirectory()) {
          if (excludedDirectories.has(entry.name)) continue;
          if (directory.depth >= 64) {
            truncated = true;
            continue;
          }
          queue.push({ path, relative: rel, depth: directory.depth + 1 });
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          if (!rel.normalize("NFC").toLocaleLowerCase().includes(needle))
            continue;
          try {
            validateProjectFiles(context, [rel]);
          } catch {
            continue;
          }
          files.push(rel);
          files.sort(compare);
          if (files.length > 40) {
            files.pop();
            truncated = true;
          }
        }
      }
    } catch {
      truncated = true;
    }
  }
  return { files, truncated };
}
