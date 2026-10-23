// Read protected compose secrets before permanently dropping privileges.
// The release compose already runs as uid 1000; legacy compose file secrets may need root.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
for (const [fileName, valueName] of [['ENCRYPTION_KEY_FILE', 'ENCRYPTION_KEY'], ['DATABASE_PASSWORD_FILE', 'DATABASE_PASSWORD']]) {
  if (process.env[fileName]) {
    process.env[valueName] = readFileSync(process.env[fileName], 'utf8').trim();
    if (fileName === 'ENCRYPTION_KEY_FILE') delete process.env[fileName];
  }
}
if (process.env.MIRACLE_VERSION) {
  const directory = process.env.MIRACLE_SECRETS_DIR || '/run/miracle';
  const state = JSON.parse(readFileSync(`${directory}/version.json`, 'utf8'));
  if (state.version !== process.env.MIRACLE_VERSION) throw new Error('Release version does not match durable state. Run start for this release; direct downgrades are refused.');
  if (existsSync(`${directory}/restore.pending`) || existsSync(`${directory}/restore.dump`)) throw new Error('Incomplete restore. Finish restore-db first.');
}
if (process.getuid?.() === 0) {
  process.setgroups([]); process.setgid(1000); process.setuid(1000);
}
const args = process.argv.slice(2);
if (!args.length || args[0] === 'server') {
  await import('../dist/server/server/index.js');
} else if (args[0] === 'node' && args[1] && !args[1].startsWith('-')) {
  process.argv = [process.execPath, resolve(args[1]), ...args.slice(2)];
  await import(pathToFileURL(process.argv[1]).href);
} else {
  const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
