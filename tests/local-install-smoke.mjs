// Release-image E2E. Requires Docker Compose v2; never uses the repository's runtime.
// MIRACLE_SMOKE_IMAGE selects an already-built image. MIRACLE_SMOKE_KEEP=1 retains
// the two disposable installations and a private credentials file for manual QA.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const image = process.env.MIRACLE_SMOKE_IMAGE || 'miracle-local-smoke:0.1.0';
const keep = process.env.MIRACLE_SMOKE_KEEP === '1';
const version = '0.1.0';
const directory = await mkdtemp(join(tmpdir(), 'miracle smoke Проверка '));
const suffix = randomBytes(6).toString('hex');
const installations = [];
let stage = 'prepare';
function progress(message) { stage = message; console.log(`[local-install-smoke] ${message}`); }

async function command(args, { input, allowFailure = false, timeout = 240000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; const errors = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(output), stderr: Buffer.concat(errors).toString() };
      if (timedOut) return reject(new Error('Docker command timed out'));
      if (code !== 0 && !allowFailure) return reject(new Error(`Docker command failed (${code}): ${result.stderr.slice(-3000)}`));
      resolve(result);
    });
    child.stdin.end(input);
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function installation(name) {
  const folder = join(directory, name); await mkdir(folder);
  const port = await freePort();
  const file = join(folder, 'compose.yaml');
  const template = await readFile(join(root, 'release/compose.yaml'), 'utf8');
  await writeFile(file, template.replace('ghcr.io/__REPOSITORY__:__VERSION__', JSON.stringify(image)).replaceAll('__VERSION__', version));
  await writeFile(join(folder, '.env'), `MIRACLE_PORT=${port}\n`);
  const project = `miracle-smoke-${suffix}-${name}`;
  const compose = (args, options) => command(['compose', '--project-directory', folder, '-f', file, '-p', project, ...args], options);
  const target = { folder, port, project, compose, origin: `http://localhost:${port}`, url: `http://127.0.0.1:${port}`, cookie: '', csrf: '' };
  installations.push(target); return target;
}
const maintenance = (target, operation, options) => target.compose(['run', '--rm', '-T', '--no-deps', 'maintenance', operation], options);
const start = (target) => target.compose(['up', '-d', '--wait', '--wait-timeout', '150', 'app']);
async function request(target, path, body) {
  const response = await fetch(target.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: target.origin, ...(target.cookie ? { cookie: target.cookie } : {}), ...(target.csrf ? { 'x-csrf-token': target.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  const cookie = response.headers.get('set-cookie'); if (cookie) target.cookie = cookie.split(';')[0];
  const result = await response.json(); if (result.csrfToken) target.csrf = result.csrfToken;
  return result;
}
async function setupLink(target) {
  return (await target.compose(['exec', '-T', 'app', 'node', 'dist/server/server/cli.js', 'setup-link'])).stdout.toString().trim();
}
async function fingerprints(target) {
  return (await target.compose(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'sha256sum', 'maintenance', '/secrets/encryption_key', '/secrets/database_password'])).stdout.toString().trim();
}
async function verifyIsolation(target) {
  const postgresId = (await target.compose(['ps', '-q', 'postgres'])).stdout.toString().trim();
  assert(postgresId, 'PostgreSQL container exists');
  const inspect = JSON.parse((await command(['inspect', postgresId])).stdout.toString())[0];
  assert(Object.values(inspect.NetworkSettings.Ports || {}).every((bindings) => bindings === null || bindings.length === 0), 'PostgreSQL must publish no ports');
  assert.equal((await target.compose(['exec', '-T', 'app', 'id', '-u'])).stdout.toString().trim(), '1000');
  const arch = (await target.compose(['exec', '-T', 'app', 'node', '-p', 'process.arch'])).stdout.toString().trim();
  if (process.env.MIRACLE_SMOKE_ARCH) assert.equal(arch, process.env.MIRACLE_SMOKE_ARCH === 'amd64' ? 'x64' : process.env.MIRACLE_SMOKE_ARCH);
  console.log(`[local-install-smoke] Runtime architecture: ${arch}`);
  const appId = (await target.compose(['ps', '-q', 'app'])).stdout.toString().trim();
  assert(appId, 'App container exists');
  const appInspect = JSON.parse((await command(['inspect', appId])).stdout.toString())[0];
  assert(Object.values(appInspect.NetworkSettings.Ports).flatMap((bindings) => bindings || []).every((binding) => binding.HostIp === '127.0.0.1'), 'App must bind only loopback');
}

try {
  progress('fresh installation, isolated volumes, and first-admin setup');
  const original = await installation('original');
  await maintenance(original, 'init'); const keys = await fingerprints(original);
  await start(original); await verifyIsolation(original);
  assert.equal((await request(original, '/api/setup/status')).required, true);
  const link = new URL(await setupLink(original));
  assert.equal(link.origin, original.origin); assert(/^#setup=[A-Za-z0-9_-]{43}$/.test(link.hash), 'Setup URL must contain a token only in its fragment');
  const password = randomBytes(24).toString('base64url'); const email = 'smoke@example.test';
  const user = await request(original, '/api/setup/complete', { token: link.hash.slice(7), email, name: 'Smoke Проверка', password });
  assert.equal(user.user.role, 'admin');
  assert.deepEqual(await request(original, '/api/connections'), []);
  const text = `Persistent note Проверка ${suffix}`;
  const board = await request(original, '/api/boards', { name: 'Smoke persistence', document: { schemaVersion: 1, nodes: [{ id: 'smoke-note', type: 'artifact', position: { x: 12, y: 34 }, data: { title: 'Saved note', kind: 'note', text } }], edges: [] } });
  const verifyBoard = async (target) => {
    const saved = await request(target, `/api/boards/${board.id}`);
    assert.equal(saved.document.nodes[0].data.text, text);
    assert.equal((await request(target, '/api/setup/status')).required, false);
    assert.deepEqual(await request(target, '/api/connections'), []);
  };
  progress('repeat initialization, start, restart, and durable credentials');
  await maintenance(original, 'init'); await start(original);
  await original.compose(['restart', 'app']); await start(original);
  await verifyBoard(original); assert.equal(await fingerprints(original), keys);
  assert.equal(await setupLink(original), original.origin);

  progress('upgrade requires a current backup');
  const newerInit = ['run', '--rm', '-T', '--no-deps', '-e', 'MIRACLE_VERSION=0.1.1', 'maintenance', 'init'];
  const blocked = await original.compose(newerInit, { allowFailure: true });
  assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /Create a backup/);

  progress('binary backup and restore into a second empty installation');
  await original.compose(['stop', 'app']);
  const backup = (await maintenance(original, 'backup')).stdout;
  assert.equal(backup[0], 0x1f); assert.equal(backup[1], 0x8b);
  const archive = join(directory, 'backup.tar.gz'); await writeFile(archive, backup, { mode: 0o600 });
  await maintenance(original, 'mark-backup');
  const restored = await installation('restored');
  await maintenance(restored, 'prepare-restore', { input: backup });
  await restored.compose(['up', '-d', '--wait', '--wait-timeout', '150', 'postgres']);
  await maintenance(restored, 'restore-db'); await maintenance(restored, 'init');
  await start(restored); await verifyIsolation(restored);
  await request(restored, '/api/auth/login', { email, password }); await verifyBoard(restored);
  assert.equal(await fingerprints(restored), keys); assert.equal(await setupLink(restored), restored.origin);
  const nonempty = await maintenance(restored, 'prepare-restore', { input: backup, allowFailure: true });
  assert.notEqual(nonempty.code, 0); assert.match(nonempty.stderr, /empty PostgreSQL and secrets volumes/);
  await verifyBoard(restored);

  progress('backup authorizes upgrade; downgrade is refused');
  await original.compose(newerInit);
  const downgrade = await maintenance(original, 'init', { allowFailure: true });
  assert.notEqual(downgrade.code, 0); assert.match(downgrade.stderr, /Downgrade/);
  assert.equal(await fingerprints(original), keys);
  // Boot the next release's environment after the version guard accepted the backup.
  const upgradedCompose = join(original.folder, 'compose.yaml');
  await writeFile(upgradedCompose, (await readFile(upgradedCompose, 'utf8')).replaceAll('MIRACLE_VERSION: 0.1.0', 'MIRACLE_VERSION: 0.1.1'));
  await start(original);
  await request(original, '/api/auth/login', { email, password });
  await verifyBoard(original);

  progress('missing/wrong encryption key refuses startup without resetting the workspace');
  await original.compose(['stop', 'app']);
  const mutateKey = (code) => original.compose(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'maintenance', '-e', code]);
  await mutateKey("require('fs').renameSync('/secrets/encryption_key','/secrets/key-test-original')");
  const missingKey = await maintenance(original, 'init', { allowFailure: true });
  assert.notEqual(missingKey.code, 0); assert.match(missingKey.stderr, /incomplete|missing credentials/i);
  await mutateKey("const fs=require('fs'); if(fs.existsSync('/secrets/encryption_key'))throw Error('Key was regenerated');fs.copyFileSync('/secrets/key-test-original','/secrets/encryption_key');fs.chownSync('/secrets/encryption_key',1000,1000);fs.writeFileSync('/secrets/encryption_key',require('crypto').randomBytes(32).toString('hex')+'\\n');");
  const wrongKey = await original.compose(['run', '--rm', '-T', '--no-deps', 'app'], { allowFailure: true, timeout: 30000 });
  assert.notEqual(wrongKey.code, 0); assert.match(wrongKey.stderr, /encryption|key/i);
  await mutateKey("const fs=require('fs');fs.renameSync('/secrets/key-test-original','/secrets/encryption_key')");
  await start(original); await request(original, '/api/auth/login', { email, password });
  await verifyBoard(original); assert.equal(await fingerprints(original), keys);

  if (keep) {
    await writeFile(join(directory, 'qa-credentials.json'), JSON.stringify({ email, password, url: restored.origin }, null, 2), { mode: 0o600 });
    console.log(`[local-install-smoke] Kept restored app: ${restored.origin}; private QA credentials: ${join(directory, 'qa-credentials.json')}`);
  }
  console.log('[local-install-smoke] PASS');
} catch (error) {
  console.error(`[local-install-smoke] FAIL during ${stage}: ${error.message}`); process.exitCode = 1;
} finally {
  if (keep) console.log(`[local-install-smoke] Retained directory: ${directory}`);
  else {
    for (const target of installations.reverse()) {
      try { await target.compose(['down', '--volumes', '--remove-orphans']); }
      catch (error) { console.error(`[local-install-smoke] Cleanup failed for ${target.project}: ${error.message}`); process.exitCode = 1; }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
