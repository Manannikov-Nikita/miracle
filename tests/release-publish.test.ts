import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function publish(tag: string, exists = false) {
  const root = mkdtempSync(join(tmpdir(), "miracle-publish-test-"));
  roots.push(root);
  const bin = join(root, "bin"),
    artifacts = join(root, "artifacts"),
    calls = join(root, "calls.jsonl");
  mkdirSync(bin);
  mkdirSync(artifacts);
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify(args)+'\\n'); if(args[0]==='release'&&args[1]==='view')process.exit(process.env.TEST_EXISTS==='1'?0:1);\n`,
    { mode: 0o755 },
  );
  if (/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag)) {
    for (const target of ["darwin-arm64", "linux-arm64", "linux-x64"]) {
      const name = `miracle-${tag.slice(1)}-${target}.tar.gz`;
      writeFileSync(join(artifacts, name), "archive");
      writeFileSync(join(artifacts, name + ".sha256"), "checksum");
    }
  }
  writeFileSync(join(artifacts, "install.sh"), "#!/bin/sh\n");
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/publish-release.mjs"), tag, artifacts],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        TEST_CALLS: calls,
        TEST_EXISTS: exists ? "1" : "0",
      },
    },
  );
  return {
    result,
    calls: existsSync(calls)
      ? readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x) as string[])
      : [],
  };
}
it("publishes a numbered beta as prerelease without changing latest", () => {
  const { result, calls } = publish("v0.12.0-beta.1");
  expect(result.status, result.stderr).toBe(0);
  expect(calls[1]).toEqual(
    expect.arrayContaining([
      "create",
      "v0.12.0-beta.1",
      "--verify-tag",
      "--prerelease",
      "--latest=false",
    ]),
  );
  expect(calls[1]!.filter((x) => x.endsWith(".tar.gz"))).toHaveLength(3);
});
it("keeps stable publication separate from prerelease", () => {
  const { result, calls } = publish("v0.12.0");
  expect(result.status, result.stderr).toBe(0);
  expect(calls[1]).not.toContain("--prerelease");
  expect(calls[1]).not.toContain("--latest=false");
});
it("never overwrites an existing beta release", () => {
  const { result, calls } = publish("v0.12.0-beta.1", true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("immutable");
  expect(calls).toHaveLength(1);
});
it.each([
  "v01.2.3",
  "v0.12.0-beta.0",
  "v0.12.0-beta.01",
  "v0.12.0-rc.1",
  "v0.12.0-beta.1/other",
  "v0.12.0-beta.1\n",
])("rejects unsupported version %s before contacting GitHub", (tag) => {
  const { result, calls } = publish(tag);
  expect(result.status).not.toBe(0);
  expect(calls).toEqual([]);
});
