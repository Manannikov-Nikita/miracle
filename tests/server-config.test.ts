import { expect, it } from "vitest";
import { resolveDataDir, resolvePort } from "../src/server/config.js";
import { join, resolve } from "node:path";
it("stores default workspace state in the selected project and preserves explicit storage overrides", () => {
  expect(resolveDataDir({})).toBe(join(process.cwd(), ".miracle"));
  expect(resolveDataDir({}, "/tmp/project")).toBe("/tmp/project/.miracle");
  expect(
    resolveDataDir({ MIRACLE_DATA_DIR: "./space dir/данные" }, "/tmp/project"),
  ).toBe(resolve("./space dir/данные"));
});
it("validates explicit service ports and retains the direct development default", () => {
  expect(resolvePort({})).toBe(3001);
  expect(resolvePort({ PORT: "4512" })).toBe(4512);
  for (const PORT of ["abc", "0", "65536", "3.2", "-1"])
    expect(() => resolvePort({ PORT })).toThrow(/Invalid PORT/);
});
