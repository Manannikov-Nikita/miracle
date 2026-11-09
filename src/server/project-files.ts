import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import type { ProjectContext } from "../shared/agents.js";
import {
  MAX_PROJECT_FILE_BYTES,
  type CreateProjectFile,
  type ProjectTextFile,
  type ProjectTree,
  type SaveProjectFile,
} from "../shared/project-files.js";
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
  return { root, data, allowed };
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

function fileError(error: unknown): never {
  if ((error as { statusCode?: number })?.statusCode) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR")
    throw problem(404, "Файл или папка не найдены", "FILE_NOT_FOUND");
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    throw problem(403, "Нет доступа к файлу или папке", "FILE_ACCESS_DENIED");
  if (code === "ELOOP")
    throw problem(
      403,
      "Символические ссылки недоступны в проводнике",
      "INVALID_FILE_PATH",
    );
  throw error;
}

/** Reject symbolic links in the selected path, including parent directories. */
function explorerPath(context: FileContext, path: string, directory = false) {
  if (!(directory && path === "") && !validRelativePath(path))
    throw problem(
      400,
      "Нужен относительный путь внутри проекта",
      "INVALID_FILE_PATH",
    );
  const { root, data, allowed } = scope(context);
  let dataIdentity: ReturnType<typeof lstatSync> | undefined;
  try {
    dataIdentity = lstatSync(data);
  } catch {}
  let absolute = root;
  for (const part of path ? path.split("/") : []) {
    absolute = join(absolute, part);
    if (!allowed(absolute) || internalNames.has(part.toLowerCase()))
      throw problem(
        403,
        "Служебная папка недоступна в проводнике",
        "INVALID_FILE_PATH",
      );
    const info = lstatSync(absolute);
    if (info.isSymbolicLink())
      throw problem(
        403,
        "Символические ссылки недоступны в проводнике",
        "INVALID_FILE_PATH",
      );
    if (
      info.isDirectory() &&
      (excludedDirectories.has(part.toLowerCase()) ||
        part.toLowerCase() === ".codegraph" ||
        (info.dev === dataIdentity?.dev && info.ino === dataIdentity.ino))
    )
      throw problem(
        403,
        "Служебная папка недоступна в проводнике",
        "INVALID_FILE_PATH",
      );
  }
  if (!allowed(realpathSync(absolute)))
    throw problem(
      403,
      "Путь находится вне доступной папки проекта",
      "INVALID_FILE_PATH",
    );
  const info = lstatSync(absolute);
  if (directory ? !info.isDirectory() : !info.isFile())
    throw problem(
      400,
      directory ? "Нужна папка проекта" : "Нужен обычный файл проекта",
      "INVALID_FILE_PATH",
    );
  return absolute;
}

/** Use filesystem identity spelling for claims; missing files need a valid parent. */
export function projectFileWorkPath(
  context: FileContext,
  path: string,
): string {
  try {
    let absolute: string;
    try {
      absolute = realpathSync(explorerPath(context, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!validRelativePath(path)) throw error;
      const parent = dirname(path) === "." ? "" : dirname(path);
      absolute = join(
        realpathSync(explorerPath(context, parent, true)),
        basename(path),
      );
      const { allowed } = scope(context);
      if (!allowed(absolute) || internalNames.has(basename(path).toLowerCase()))
        throw problem(403, "Служебный путь недоступен", "INVALID_FILE_PATH");
    }
    return relative(scope(context).root, absolute).split(sep).join("/");
  } catch (error) {
    return fileError(error);
  }
}

export async function listProjectTree(
  context: FileContext,
  path = "",
  limits: { maxEntries?: number } = {},
): Promise<ProjectTree> {
  try {
    const absolute = explorerPath(context, path, true);
    const result: ProjectTree = { path, entries: [], truncated: false };
    const directory = await opendir(absolute);
    const maxEntries = limits.maxEntries ?? 2000;
    let visited = 0;
    for await (const entry of directory) {
      if (++visited > maxEntries) {
        result.truncated = true;
        break;
      }
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      try {
        const target = explorerPath(context, child, entry.isDirectory());
        result.entries.push({
          path: child,
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : "file",
          ...(entry.isFile() ? { size: lstatSync(target).size } : {}),
        });
      } catch {
        // Files may disappear during enumeration; inaccessible entries stay hidden.
      }
    }
    result.entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return result;
  } catch (error) {
    fileError(error);
  }
}

const tooLarge = () =>
  problem(
    413,
    "Файл больше 2 МиБ и не может быть открыт в редакторе",
    "FILE_TOO_LARGE",
  );
const notText = () =>
  problem(
    415,
    "Редактор поддерживает текстовые файлы в кодировке UTF-8",
    "FILE_NOT_TEXT",
  );
const conflict = () =>
  problem(
    409,
    "Файл изменён на диске. Загрузите актуальную версию перед сохранением",
    "FILE_REVISION_CONFLICT",
  );
const binaryControls = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

function readText(context: FileContext, path: string) {
  const absolute = explorerPath(context, path);
  const fd = openSync(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    const current = lstatSync(explorerPath(context, path));
    if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino)
      throw conflict();
    if (info.size > MAX_PROJECT_FILE_BYTES) throw tooLarge();
    const buffer = Buffer.alloc(MAX_PROJECT_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!count) break;
      length += count;
    }
    if (length > MAX_PROJECT_FILE_BYTES) throw tooLarge();
    const after = fstatSync(fd);
    if (
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs
    )
      throw conflict();
    const bytes = buffer.subarray(0, length);
    let content: string;
    try {
      // Preserve an optional UTF-8 BOM so an unchanged save is byte-for-byte stable.
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw notText();
    }
    if (binaryControls.test(content)) throw notText();
    const document: ProjectTextFile = {
      path,
      name: basename(path),
      content,
      revision: createHash("sha256").update(bytes).digest("hex"),
      size: length,
      updatedAt: info.mtime.toISOString(),
    };
    return { document, absolute, mode: info.mode };
  } finally {
    closeSync(fd);
  }
}

export function readProjectFile(
  context: FileContext,
  path: string,
): ProjectTextFile {
  try {
    return readText(context, path).document;
  } catch (error) {
    fileError(error);
  }
}

/** Search uses the explorer's text boundary, but never blocks HTTP on file I/O. */
export async function scanProjectTextFiles(
  context: FileContext,
  visit: (file: ProjectTextFile) => void,
  signal?: AbortSignal,
): Promise<{ incomplete: boolean }> {
  const { root, data, allowed } = scope(context);
  const dataIdentity = await lstat(data).catch(() => undefined);
  const check = () => signal?.throwIfAborted();
  const accessible = async (path: string, directory = false) => {
    check();
    if (!(directory && path === "") && !validRelativePath(path))
      throw problem(403, "Недоступный путь проекта", "INVALID_FILE_PATH");
    let absolute = root;
    for (const part of path ? path.split("/") : []) {
      absolute = join(absolute, part);
      if (!allowed(absolute) || internalNames.has(part.toLowerCase()))
        throw problem(403, "Служебная папка", "INVALID_FILE_PATH");
      const info = await lstat(absolute);
      if (
        info.isSymbolicLink() ||
        (info.isDirectory() &&
          (excludedDirectories.has(part.toLowerCase()) ||
            part.toLowerCase() === ".codegraph" ||
            (info.dev === dataIdentity?.dev && info.ino === dataIdentity.ino)))
      )
        throw problem(403, "Недоступный путь проекта", "INVALID_FILE_PATH");
    }
    if (!allowed(await realpath(absolute)))
      throw problem(403, "Путь вне проекта", "INVALID_FILE_PATH");
    const info = await lstat(absolute);
    if (directory ? !info.isDirectory() : !info.isFile()) throw conflict();
    check();
    return { absolute, info };
  };
  const read = async (path: string) => {
    const { absolute } = await accessible(path);
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      const current = await accessible(path);
      if (
        !info.isFile() ||
        info.dev !== current.info.dev ||
        info.ino !== current.info.ino
      )
        throw conflict();
      if (info.size > MAX_PROJECT_FILE_BYTES) throw tooLarge();
      const buffer = Buffer.alloc(
        Math.min(MAX_PROJECT_FILE_BYTES + 1, info.size + 1),
      );
      let length = 0;
      while (length < buffer.length) {
        check();
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (
        after.size > MAX_PROJECT_FILE_BYTES ||
        length > MAX_PROJECT_FILE_BYTES
      )
        throw tooLarge();
      if (
        info.size !== after.size ||
        info.mtimeMs !== after.mtimeMs ||
        info.ctimeMs !== after.ctimeMs
      )
        throw conflict();
      const bytes = buffer.subarray(0, length);
      let content: string;
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw notText();
      }
      if (binaryControls.test(content)) throw notText();
      check();
      visit({
        path,
        name: basename(path),
        content,
        revision: createHash("sha256").update(bytes).digest("hex"),
        size: length,
        updatedAt: info.mtime.toISOString(),
      });
    } finally {
      await handle.close();
    }
  };
  let incomplete = false;
  const pending = new Set<Promise<void>>();
  const directories = [""];
  try {
    for (let cursor = 0; cursor < directories.length; cursor++) {
      check();
      const path = directories[cursor];
      try {
        const { absolute } = await accessible(path, true);
        const directory = await opendir(absolute);
        for await (const entry of directory) {
          check();
          const relativePath = path ? `${path}/${entry.name}` : entry.name;
          if (
            !validRelativePath(relativePath) ||
            internalNames.has(entry.name.toLowerCase()) ||
            !allowed(join(root, relativePath))
          )
            continue;
          if (entry.isDirectory()) {
            if (
              !excludedDirectories.has(entry.name.toLowerCase()) &&
              entry.name.toLowerCase() !== ".codegraph"
            )
              directories.push(relativePath);
          } else if (entry.isFile()) {
            let task: Promise<void>;
            task = read(relativePath)
              .catch((error: unknown) => {
                if (
                  !signal?.aborted &&
                  !["FILE_TOO_LARGE", "FILE_NOT_TEXT"].includes(
                    (error as { code?: string }).code ?? "",
                  )
                )
                  incomplete = true;
              })
              .finally(() => pending.delete(task));
            pending.add(task);
            if (pending.size >= 4) await Promise.race(pending);
          }
        }
      } catch {
        check();
        incomplete = true;
      }
    }
  } finally {
    await Promise.all(pending);
  }
  check();
  return { incomplete };
}

export function createProjectFile(
  context: FileContext,
  input: CreateProjectFile,
  beforeWrite?: (path: string) => void,
): ProjectTextFile {
  try {
    const { directory, name } = input;
    if (
      !name.trim() ||
      name === "." ||
      name === ".." ||
      /[\\/\u0000-\u001f\u007f<>:"|?*]/.test(name) ||
      Buffer.byteLength(name, "utf8") > 255 ||
      Buffer.from(name, "utf8").toString("utf8") !== name
    )
      throw problem(
        400,
        "Введите имя файла без пути и недопустимых символов (до 255 байт)",
        "INVALID_FILE_NAME",
      );
    const parent = explorerPath(context, directory, true);
    const path = directory ? `${directory}/${name}` : name;
    if (!validRelativePath(path))
      throw problem(400, "Слишком длинный путь к файлу", "INVALID_FILE_PATH");
    const absolute = join(parent, name);
    const { allowed } = scope(context);
    if (!allowed(absolute) || internalNames.has(name.toLowerCase()))
      throw problem(
        403,
        "Служебный путь недоступен в проводнике",
        "INVALID_FILE_PATH",
      );
    beforeWrite?.(path);
    // Exclusive creation keeps an existing file, directory or link untouched.
    const fd = openSync(
      absolute,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o666,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return readProjectFile(context, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST")
      throw problem(
        409,
        "Файл или папка с таким именем уже существует",
        "FILE_ALREADY_EXISTS",
      );
    return fileError(error);
  }
}

export function saveProjectFile(
  context: FileContext,
  path: string,
  input: SaveProjectFile,
): ProjectTextFile {
  let temporary: string | undefined;
  try {
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length > MAX_PROJECT_FILE_BYTES) throw tooLarge();
    if (
      binaryControls.test(input.content) ||
      bytes.toString("utf8") !== input.content
    )
      throw notText();
    const current = readText(context, path);
    if (current.document.revision !== input.baseRevision) throw conflict();
    temporary = join(
      dirname(current.absolute),
      `.miracle-edit-${randomUUID()}.tmp`,
    );
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fchmodSync(fd, current.mode & 0o777);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Recheck both confinement and content immediately before replacing the file.
    if (readText(context, path).document.revision !== input.baseRevision)
      throw conflict();
    renameSync(temporary, current.absolute);
    temporary = undefined;
    return readProjectFile(context, path);
  } catch (error) {
    return fileError(error);
  } finally {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
}
