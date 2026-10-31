import { join, resolve } from "node:path";
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): string {
  return resolve(env.MIRACLE_DATA_DIR || join(projectRoot, ".miracle"));
}
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.PORT || "3001";
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error("Invalid PORT: expected an integer from 1 to 65535");
  return Number(value);
}
