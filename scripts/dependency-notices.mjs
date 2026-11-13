import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

// Uses the locked dependency graph, including DuckDB's optional platform binaries. No network.
const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const tools = new Set([
  "@types/jsdom",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "concurrently",
  "jsdom",
  "prettier",
  "tsx",
  "typescript",
  "vite",
  "vitest",
]);
const included = new Set();
function visit(name, from = "") {
  let parent = from;
  let path;
  while (true) {
    const candidate = (parent ? parent + "/" : "") + "node_modules/" + name;
    if (lock.packages[candidate]) {
      path = candidate;
      break;
    }
    if (!parent) return;
    parent = parent.includes("/node_modules/")
      ? parent.slice(0, parent.lastIndexOf("/node_modules/"))
      : "";
  }
  if (included.has(path)) return;
  included.add(path);
  const info = lock.packages[path];
  for (const dependency of Object.keys(info.dependencies || {}))
    visit(dependency, path);
  // Release archives install the host-specific native package. Include every
  // locked DuckDB target, without pulling unrelated optional build tools in.
  if (name === "@duckdb/node-bindings")
    for (const dependency of Object.keys(info.optionalDependencies || {}))
      if (dependency.startsWith("@duckdb/node-bindings-"))
        visit(dependency, path);
  for (const dependency of Object.keys(info.peerDependencies || {})) {
    if (!dependency.startsWith("@types/")) visit(dependency, path);
  }
}
for (const name of [
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.devDependencies).filter((name) => !tools.has(name)),
])
  visit(name);
const entries = Object.entries(lock.packages).filter(
  ([path, info]) => included.has(path) && !info.link,
);
const sections = [];
for (const [path, info] of entries.sort(([a], [b]) => a.localeCompare(b))) {
  const name = path.split("node_modules/").at(-1);
  let source = join(root, path);
  if (name.startsWith("@node-rs/argon2-"))
    source = join(root, "node_modules/@node-rs/argon2");
  if (name.startsWith("@duckdb/node-bindings-")) {
    const common = join(root, "node_modules/@duckdb/node-bindings");
    const parent = JSON.parse(
      await readFile(join(common, "package.json"), "utf8"),
    );
    if (info.version !== parent.version || info.license !== parent.license)
      throw new Error(`Review the native DuckDB license for ${name}.`);
    let installed;
    try {
      installed = JSON.parse(
        await readFile(join(source, "package.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Native tarballs and the bindings package share this upstream license.
    // Verify the installed target on each release host before using the common
    // text for the other locked, intentionally uninstalled platforms.
    if (
      installed &&
      (installed.version !== parent.version ||
        installed.license !== parent.license ||
        (await readFile(join(source, "LICENSE"), "utf8")) !==
          (await readFile(join(common, "LICENSE"), "utf8")))
    )
      throw new Error(
        `Native DuckDB license differs for ${name}; review before release.`,
      );
    source = common;
  }
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const names = await readdir(source);
  let legal = names.filter((n) =>
    /^(licen[cs]e|copying|notice|copyright)([. -]|$)/i.test(n),
  );
  let texts = await Promise.all(
    legal.map(
      async (n) => `### ${n}\n\n${await readFile(join(source, n), "utf8")}`,
    ),
  );
  if (!texts.length) {
    if (["abstract-logging", "react-remove-scroll-bar"].includes(name)) {
      texts = [
        await readFile(
          join(root, "licenses/upstream", `${name}-LICENSE`),
          "utf8",
        ),
      ];
    } else {
      const readme = names.find((n) => /^readme/i.test(n));
      const text = readme ? await readFile(join(source, readme), "utf8") : "";
      const match =
        /(?:^|\n)(?:#{1,6}\s+license\b[^\n]*|License\n[-=]+)\s*\n([\s\S]+)/i.exec(
          text,
        );
      if (!match)
        throw new Error(
          `No license text for ${name}; review dependency before release.`,
        );
      texts = [match[0].trim()];
    }
  }
  const repository =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  sections.push(
    `## ${name} ${info.version}\n\nLicense: ${info.license || pkg.license}\nSource: ${repository || info.resolved}\n\n${texts.join("\n\n")}`,
  );
}
sections.push(
  `## Pasta UI (adapted components)\n\nLicense: MIT\nSource: https://github.com/syeddhasnainn/pastaui/blob/1f6de38bf4dc82cf17bb662361b3c03bebbfc4d4/src/components/ai/context-breakdown.tsx\nSource: https://github.com/syeddhasnainn/pastaui/blob/1f6de38bf4dc82cf17bb662361b3c03bebbfc4d4/src/components/ai/agent-activity.tsx\n\n${await readFile(join(root, "licenses/upstream/pastaui-LICENSE"), "utf8")}`,
);
const output = `# Third-party notices\n\nGenerated from package-lock.json and adapted-source licenses by scripts/dependency-notices.mjs. Includes server dependencies and browser dependencies bundled into the web application. Individual upstream licenses apply; Miracle's Apache-2.0 license does not replace them.\n\nNative release archives also contain Node.js; its complete upstream license is included at runtime/LICENSE. Browser dependencies are bundled by Vite and their notices are included below.\n\n${sections.join("\n\n---\n\n")}\n`;
// Keep license wording intact while making generated output stable across OSes.
await writeFile(
  join(root, "THIRD_PARTY_NOTICES.md"),
  output
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd() + "\n",
);
console.log(`Dependency notices: ${entries.length} packages.`);
