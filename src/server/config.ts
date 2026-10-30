import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIRACLE_DATA_DIR) return resolve(env.MIRACLE_DATA_DIR);
  const home = env.HOME || env.USERPROFILE || homedir();
  const root =
    platform() === "darwin"
      ? join(home, "Library", "Application Support", "Miracle")
      : platform() === "win32"
        ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Miracle")
        : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "miracle");
  return join(root, "data");
}
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.PORT || "3001";
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error("Invalid PORT: expected an integer from 1 to 65535");
  return Number(value);
}
