import { expect, it } from "vitest";
import { resolveDataDir, resolvePort } from "../src/server/config.js";
import { isAbsolute, resolve } from "node:path";
it("resolves a stable OS data directory independently of cwd and honors explicit overrides", () => {
  expect(isAbsolute(resolveDataDir({}))).toBe(true);
  expect(resolveDataDir({ MIRACLE_DATA_DIR: "./space dir/данные" })).toBe(
    resolve("./space dir/данные"),
  );
  expect(resolvePort({})).toBe(3001);
  expect(resolvePort({ PORT: "4512" })).toBe(4512);
  for (const PORT of ["abc", "0", "65536", "3.2", "-1"])
    expect(() => resolvePort({ PORT })).toThrow(/Invalid PORT/);
});
