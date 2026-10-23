import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const [repository, version, outputArgument] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^\d+\.\d+\.\d+$/.test(version || '')) {
  throw new Error('Usage: node scripts/build-release.mjs owner/repository 1.2.3 [output-directory]');
}
const output = resolve(outputArgument || join(root, '.local/releases'));
const name = `miracle-${version}`;
const stage = join(output, name);
// Explicit allowlist: never package the working tree, .env, keys, certificates or data.
export const releaseFiles = ['compose.yaml', 'start.sh', 'stop.sh', 'backup.sh', 'restore.sh', 'common.sh', 'start.cmd', 'stop.cmd', 'backup.cmd', 'restore.cmd', 'local.ps1'];
await mkdir(output, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(stage);
for (const file of releaseFiles) await cp(join(root, 'release', file), join(stage, file));
const composePath = join(stage, 'compose.yaml');
await writeFile(composePath, (await readFile(composePath, 'utf8')).replaceAll('__REPOSITORY__', repository.toLowerCase()).replaceAll('__VERSION__', version));
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, file), join(stage, file));
await cp(join(root, 'docs/local-installation.md'), join(stage, 'README.md'));
await writeFile(join(stage, 'settings.env'), '# Local port. Change this one setting, then run start again.\nMIRACLE_PORT=3001\n');
const zip = join(output, `${name}.zip`);
await rm(zip, { force: true });
execFileSync('zip', ['-qr', zip, name], { cwd: output, stdio: 'inherit' });
const sha = createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(`${zip}.sha256`, `${sha}  ${basename(zip)}\n`);
console.log(zip);
