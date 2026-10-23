// Runs inside the image as root for volume initialization and maintenance only.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, chownSync, rmSync, mkdtempSync, lstatSync, rmdirSync, openSync, readSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const credentialNames = ['encryption_key', 'database_password'];
function privateFile(path, value, exclusive = false) {
  writeFileSync(path, value, { mode: 0o600, flag: exclusive ? 'wx' : 'w', flush: true }); chmodSync(path, 0o600);
  if (process.getuid?.() === 0) chownSync(path, 1000, 1000);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function readState(secrets) { return JSON.parse(readFileSync(join(secrets, 'version.json'), 'utf8')); }
function writeState(secrets, state) { privateFile(join(secrets, 'version.json'), `${JSON.stringify(state)}\n`); }
function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must use X.Y.Z.');
  return version.split('.').map(Number);
}
function compareVersions(a, b) {
  const left = versionParts(a); const right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function checkCredentials(secrets) {
  for (const name of credentialNames) {
    const path = join(secrets, name);
    if (!existsSync(path) || !/^[a-f0-9]{64}$/.test(readFileSync(path, 'utf8').trim())) throw new Error(`Invalid or missing credentials: ${name}. Restore the matching backup; never generate a replacement key.`);
  }
}
export function initializeState(paths) {
  const { secrets, data, version } = paths;
  versionParts(version); mkdirSync(secrets, { recursive: true }); mkdirSync(data, { recursive: true });
  const lock = join(secrets, '.initialize-lock');
  try { mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another initialization is active or was interrupted. Retry after it finishes; do not replace credentials.'); throw error; }
  try { initializeLocked(paths); } finally { rmdirSync(lock); }
}
function initializeLocked({ secrets, data, version }) {
  if (existsSync(join(secrets, 'restore.pending')) || existsSync(join(secrets, 'restore.dump'))) throw new Error('An incomplete restore is pending. Finish restore-db before starting the app.');
  const present = credentialNames.filter((name) => existsSync(join(secrets, name)));
  if (present.length === 0) {
    if (readdirSync(data).length) throw new Error('Existing PostgreSQL data has missing credentials. Restore the matching key and password from backup.');
    if (readdirSync(secrets).filter((name) => name !== '.initialize-lock').length) throw new Error('Secrets volume is incomplete. Restore its matching backup.');
    for (const name of credentialNames) privateFile(join(secrets, name), `${randomBytes(32).toString('hex')}\n`, true);
    writeState(secrets, { version });
  } else if (present.length !== credentialNames.length || !existsSync(join(secrets, 'version.json'))) {
    throw new Error('Secrets volume is incomplete. Restore its matching backup.');
  }
  checkCredentials(secrets);
  const state = readState(secrets); const comparison = compareVersions(version, state.version);
  if (comparison < 0) throw new Error(`Downgrade from ${state.version} to ${version} refused. Restore a matching old backup into an empty installation.`);
  if (comparison > 0) {
    if (state.backupForVersion !== state.version) throw new Error(`Create a backup using release ${state.version} before upgrading to ${version}.`);
    writeState(secrets, { version, upgradedFrom: state.version });
  }
  // Every permitted start opens a new write generation. A backup exported before
  // this start cannot subsequently authorize an upgrade.
  const next = readState(secrets);
  delete next.backupForVersion; delete next.backupAt; delete next.backupCandidate;
  next.generation = randomBytes(16).toString('hex'); writeState(secrets, next);
}
export function recordBackup({ secrets }, requireCandidate = false) {
  checkCredentials(secrets); const state = readState(secrets);
  if (requireCandidate && (!state.generation || state.backupCandidate !== state.generation)) throw new Error('The app was started after this backup. Take another backup before upgrading.');
  delete state.backupCandidate;
  writeState(secrets, { ...state, backupForVersion: state.version, backupAt: new Date().toISOString() });
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status}).`);
  return result;
}
function databaseEnv(secrets) {
  checkCredentials(secrets);
  return { ...process.env, PGHOST: process.env.DATABASE_HOST || 'postgres', PGPORT: '5432', PGDATABASE: 'miracle', PGUSER: 'miracle', PGPASSWORD: readFileSync(join(secrets, 'database_password'), 'utf8').trim() };
}
function backup(paths) {
  const lock = join(paths.secrets, '.initialize-lock');
  try { mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another initialization or backup is active.'); throw error; }
  try { backupLocked(paths); } finally { rmdirSync(lock); }
}
function backupLocked(paths) {
  const folder = mkdtempSync(join(tmpdir(), 'miracle-backup-'));
  try {
    checkCredentials(paths.secrets);
    if (existsSync(join(paths.secrets, 'restore.pending')) || existsSync(join(paths.secrets, 'restore.dump'))) throw new Error('Cannot back up an incomplete restore.');
    run('pg_dump', ['--format=custom', '--no-owner', '--file', join(folder, 'database.dump')], { env: databaseEnv(paths.secrets) });
    for (const name of [...credentialNames, 'version.json']) copyFileSync(join(paths.secrets, name), join(folder, name));
    run('tar', ['-czf', '-', '-C', folder, 'database.dump', ...credentialNames, 'version.json']);
    const state = readState(paths.secrets);
    writeState(paths.secrets, { ...state, backupCandidate: state.generation });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
export function assertEmptyRestoreTarget({ secrets, data }, allowOwnLock = false) {
  for (const dir of [secrets, data]) {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).filter((name) => !(allowOwnLock && dir === secrets && name === '.initialize-lock')).length) throw new Error('Restore requires empty PostgreSQL and secrets volumes. Existing data was left untouched.');
  }
}
function prepareRestore(paths) {
  mkdirSync(paths.secrets, { recursive: true });
  const lock = join(paths.secrets, '.initialize-lock');
  try { mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another initialization or restore is active.'); throw error; }
  try { prepareRestoreLocked(paths); } finally { rmdirSync(lock); }
}
function prepareRestoreLocked(paths) {
  assertEmptyRestoreTarget(paths, true);
  const folder = mkdtempSync(join(tmpdir(), 'miracle-restore-'));
  try {
    const archive = join(folder, 'backup.tar.gz');
    run('sh', ['-c', 'cat > "$1"', 'sh', archive], { stdio: ['inherit', 'inherit', 'inherit'] });
    const listing = run('tar', ['-tzf', archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).stdout.trim().split('\n');
    const allowed = ['database.dump', ...credentialNames, 'version.json'];
    if (listing.length !== allowed.length || new Set(listing).size !== allowed.length || listing.some((name) => !allowed.includes(name))) throw new Error('Invalid backup archive contents.');
    const unpacked = join(folder, 'unpacked'); mkdirSync(unpacked);
    run('tar', ['-xzf', archive, '--no-same-owner', '-C', unpacked]);
    for (const name of allowed) if (!lstatSync(join(unpacked, name)).isFile()) throw new Error('Backup must contain regular files only.');
    checkCredentials(unpacked); const state = readState(unpacked); versionParts(state.version);
    if (compareVersions(paths.version, state.version) < 0) throw new Error('Cannot restore a newer backup with an older release.');
    const header = Buffer.alloc(5); const dump = openSync(join(unpacked, 'database.dump'), 'r');
    try { readSync(dump, header, 0, 5, 0); } finally { closeSync(dump); }
    if (header.toString() !== 'PGDMP') throw new Error('Invalid PostgreSQL dump.');
    // Commit a durable refusal marker before copying any credentials. An interrupted
    // restore must never look like a valid, newly initialized empty database.
    privateFile(join(paths.secrets, 'restore.pending'), `${new Date().toISOString()}\n`, true);
    for (const name of [...credentialNames, 'version.json']) privateFile(join(paths.secrets, name), readFileSync(join(unpacked, name)));
    copyFileSync(join(unpacked, 'database.dump'), join(paths.secrets, 'restore.dump')); chmodSync(join(paths.secrets, 'restore.dump'), 0o600);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
function restoreDatabase(paths) {
  if (!existsSync(join(paths.secrets, 'restore.dump'))) throw new Error('No staged restore found.');
  run('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--dbname', 'miracle', join(paths.secrets, 'restore.dump')], { env: databaseEnv(paths.secrets) });
  recordBackup(paths);
  rmSync(join(paths.secrets, 'restore.dump'));
  rmSync(join(paths.secrets, 'restore.pending'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = { secrets: process.env.MIRACLE_SECRETS_DIR || '/secrets', data: process.env.MIRACLE_DATA_DIR || '/pgdata', version: process.env.MIRACLE_VERSION || '' };
  try {
    const command = process.argv[2];
    if (command === 'init') initializeState(paths);
    else if (command === 'backup') backup(paths);
    else if (command === 'mark-backup') {
      const lock = join(paths.secrets, '.initialize-lock');
      try { mkdirSync(lock); } catch { throw new Error('Another initialization or backup is active.'); }
      try { recordBackup(paths, true); } finally { rmdirSync(lock); }
    }
    else if (command === 'prepare-restore') prepareRestore(paths);
    else if (command === 'restore-db') restoreDatabase(paths);
    else if (command === 'restore-check') assertEmptyRestoreTarget(paths);
    else throw new Error('Unknown maintenance command.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
