import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Uses the locked dependency graph, including optional platform binaries. No network.
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const entries = Object.entries(lock.packages).filter(([path, info]) => path && !info.dev && !info.link);
const sections = [];
for (const [path, info] of entries.sort(([a], [b]) => a.localeCompare(b))) {
  const name = path.split('node_modules/').at(-1);
  let source = join(root, path);
  if (name.startsWith('@node-rs/argon2-')) source = join(root, 'node_modules/@node-rs/argon2');
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const names = await readdir(source);
  let legal = names.filter(n => /^(licen[cs]e|copying|notice|copyright)([. -]|$)/i.test(n));
  let texts = await Promise.all(legal.map(async n => `### ${n}\n\n${await readFile(join(source, n), 'utf8')}`));
  if (!texts.length) {
    if (['abstract-logging', 'react-remove-scroll-bar'].includes(name)) {
      texts = [await readFile(join(root, 'licenses/upstream', `${name}-LICENSE`), 'utf8')];
    } else {
      const readme = names.find(n => /^readme/i.test(n));
      const text = readme ? await readFile(join(source, readme), 'utf8') : '';
      const match = /(?:^|\n)(?:#{1,6}\s+license\b[^\n]*|License\n[-=]+)\s*\n([\s\S]+)/i.exec(text);
      if (!match) throw new Error(`No license text for ${name}; review dependency before release.`);
      texts = [match[0].trim()];
    }
  }
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  sections.push(`## ${name} ${info.version}\n\nLicense: ${info.license || pkg.license}\nSource: ${repository || info.resolved}\n\n${texts.join('\n\n')}`);
}
const output = `# Third-party notices\n\nGenerated from package-lock.json by scripts/dependency-notices.mjs. Includes production dependencies and platform variants. Individual upstream licenses apply; Miracle's Apache-2.0 license does not replace them.\n\nThe Docker image also contains Node.js, PostgreSQL client tools and Debian components. Node's LICENSE is installed at /usr/local/share/doc/node/LICENSE; operating-system notices remain under /usr/share/doc in the image. PostgreSQL is distributed under the PostgreSQL License (https://www.postgresql.org/about/licence/).\n\n${sections.join('\n\n---\n\n')}\n`;
// Keep license wording intact while making generated output stable across OSes.
await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), output.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n');
console.log(`Dependency notices: ${entries.length} packages.`);
