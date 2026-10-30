import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
await rm(resolve(root, "dist/server"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.server.json",
  ],
  { cwd: root, stdio: "inherit" },
);
