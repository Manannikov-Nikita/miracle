// Called only by the tag workflow after all native artifacts passed verification.
import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve, join } from "node:path";
const [tag, directory] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag || "") || !directory)
  throw Error(
    "Usage: node scripts/publish-release.mjs v1.2.3 verified-artifact-directory",
  );
const existing = spawnSync("gh", ["release", "view", tag], { stdio: "ignore" });
if (existing.error) throw existing.error;
if (existing.status === 0)
  throw Error(
    "Release already exists. Published version assets are immutable; use a new version instead of replacing them.",
  );
const version = tag.slice(1),
  output = resolve(directory);
const files = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
].flatMap((target) => {
  const name = `miracle-${version}-${target}.tar.gz`;
  return [join(output, name), join(output, name + ".sha256")];
});
files.push(join(output, "install.sh"));
for (const file of files)
  if (!statSync(file).isFile())
    throw Error("Missing verified release artifact: " + file);
const notes = resolve(".github/release-notes", version + ".md");
let hasNotes = false;
try {
  hasNotes = statSync(notes).isFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
execFileSync(
  "gh",
  [
    "release",
    "create",
    tag,
    "--verify-tag",
    "--title",
    `Miracle ${version}`,
    ...(hasNotes ? ["--notes-file", notes] : ["--generate-notes"]),
    ...files,
  ],
  { stdio: "inherit" },
);
