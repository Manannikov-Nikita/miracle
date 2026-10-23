import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'miracle release пробел '));
  folders.push(root);
  const secrets = join(root, 'secrets');
  const data = join(root, 'data');
  mkdirSync(secrets); mkdirSync(data);
  return { secrets, data, version: '0.1.0' };
}
afterEach(() => folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('Docker local distribution durable state', () => {
  it('creates random durable credentials once and preserves them on another launch', async () => {
    const { initializeState } = await import('../scripts/local-state.mjs');
    const paths = fixture();
    initializeState(paths);
    const key = readFileSync(join(paths.secrets, 'encryption_key'), 'utf8');
    const password = readFileSync(join(paths.secrets, 'database_password'), 'utf8');
    expect(key).toMatch(/^[a-f0-9]{64}\n$/);
    expect(password).toMatch(/^[a-f0-9]{64}\n$/);
    expect(password).not.toBe(key);
    initializeState(paths);
    expect(readFileSync(join(paths.secrets, 'encryption_key'), 'utf8')).toBe(key);
    expect(readFileSync(join(paths.secrets, 'database_password'), 'utf8')).toBe(password);
  });
  it('refuses to generate credentials beside existing PostgreSQL data', async () => {
    const { initializeState } = await import('../scripts/local-state.mjs');
    const paths = fixture(); writeFileSync(join(paths.data, 'PG_VERSION'), '17');
    expect(() => initializeState(paths)).toThrow(/missing.*credentials/i);
  });
  it('refuses partial credentials even on an otherwise empty install', async () => {
    const { initializeState } = await import('../scripts/local-state.mjs');
    const paths = fixture(); writeFileSync(join(paths.secrets, 'encryption_key'), 'a'.repeat(64));
    expect(() => initializeState(paths)).toThrow(/incomplete/i);
  });
  it('requires a successful backup before changing versions and rejects downgrades', async () => {
    const { initializeState, recordBackup } = await import('../scripts/local-state.mjs');
    const paths = fixture(); initializeState(paths);
    expect(() => initializeState({ ...paths, version: '0.2.0' })).toThrow(/backup/i);
    recordBackup(paths);
    initializeState({ ...paths, version: '0.2.0' });
    expect(() => initializeState(paths)).toThrow(/downgrade/i);
  });
  it('blocks start while an incomplete restore is staged', async () => {
    const { initializeState } = await import('../scripts/local-state.mjs');
    const paths = fixture(); initializeState(paths);
    writeFileSync(join(paths.secrets, 'restore.dump'), 'pending');
    expect(() => initializeState(paths)).toThrow(/restore/i);
  });
});

describe('backup lifecycle and restore guard', () => {
  it('requires a new backup after restarting the app', async () => {
    const { initializeState, recordBackup } = await import('../scripts/local-state.mjs');
    const paths = fixture(); initializeState(paths); recordBackup(paths);
    initializeState(paths);
    expect(() => initializeState({ ...paths, version: '0.2.0' })).toThrow(/backup/i);
  });
  it('refuses to restore over either existing secrets or existing data', async () => {
    const { assertEmptyRestoreTarget } = await import('../scripts/local-state.mjs');
    const paths = fixture();
    expect(() => assertEmptyRestoreTarget(paths)).not.toThrow();
    writeFileSync(join(paths.secrets, 'encryption_key'), 'existing key');
    expect(() => assertEmptyRestoreTarget(paths)).toThrow(/empty/i);
    expect(readFileSync(join(paths.secrets, 'encryption_key'), 'utf8')).toBe('existing key');
    rmSync(join(paths.secrets, 'encryption_key'));
    writeFileSync(join(paths.data, 'PG_VERSION'), '17');
    expect(() => assertEmptyRestoreTarget(paths)).toThrow(/empty/i);
    expect(readFileSync(join(paths.data, 'PG_VERSION'), 'utf8')).toBe('17');
  });
});

describe('concurrent initialization', () => {
  it('refuses a concurrent initializer without writing any credentials', async () => {
    const { initializeState } = await import('../scripts/local-state.mjs');
    const paths = fixture();
    mkdirSync(join(paths.secrets, '.initialize-lock'));
    expect(() => initializeState(paths)).toThrow(/initialization/i);
    expect(() => readFileSync(join(paths.secrets, 'encryption_key'))).toThrow();
    rmSync(join(paths.secrets, '.initialize-lock'), { recursive: true });
    initializeState(paths);
    expect(readFileSync(join(paths.secrets, 'encryption_key'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/);
  });
});

describe('shell release launcher', () => {
  it('starts from a path with spaces and Unicode and prints the one-time setup URL', async () => {
    const { copyFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const root = mkdtempSync(join(tmpdir(), 'miracle launcher Кириллица ')); folders.push(root);
    const tools = join(root, 'tools'); mkdirSync(tools);
    const log = join(root, 'docker.log');
    for (const name of ['common.sh', 'start.sh', 'compose.yaml']) copyFileSync(fileURLToPath(new URL(`../release/${name}`, import.meta.url)), join(root, name));
    writeFileSync(join(root, 'settings.env'), 'MIRACLE_PORT=3456\n');
    writeFileSync(join(tools, 'docker'), '#!/bin/sh\nprintf "<%s>" "$@" >> "$DOCKER_TEST_LOG"\nprintf "\\n" >> "$DOCKER_TEST_LOG"\ncase "$*" in *"exec -T app node dist/server/server/cli.js setup-link"*) echo "http://localhost:3456/#setup=test-token";; esac\n', { mode: 0o755 });
    writeFileSync(join(tools, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('sh', [join(root, 'start.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${tools}:/usr/bin:/bin`, DOCKER_TEST_LOG: log, MIRACLE_PORT: '3456' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('http://localhost:3456/#setup=test-token');
    const commands = readFileSync(log, 'utf8');
    expect(commands).toContain(`<--env-file><${join(root, 'settings.env')}>`);
    expect(commands).toContain('<up><-d><--wait><--wait-timeout><180><postgres><app>');
    expect(commands).toContain('<run><--rm><-T><--no-deps><maintenance><init>');
    expect(commands).not.toContain('<build>');
  });
  it('gives a Docker daemon instruction and stops before initializing data', async () => {
    const { copyFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const root = mkdtempSync(join(tmpdir(), 'miracle no daemon ')); folders.push(root);
    for (const name of ['common.sh', 'start.sh']) copyFileSync(fileURLToPath(new URL(`../release/${name}`, import.meta.url)), join(root, name));
    writeFileSync(join(root, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = spawnSync('sh', [join(root, 'start.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:/usr/bin:/bin` } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Start Docker Desktop or the Docker daemon/);
  });
});

describe('interrupted restore', () => {
  it('refuses initialization when restore stopped before copying any keys', async () => {
    const { initializeState } = await import('../scripts/local-state.mjs');
    const paths = fixture();
    writeFileSync(join(paths.secrets, 'restore.pending'), 'interrupted');
    expect(() => initializeState(paths)).toThrow(/restore/i);
    expect(() => readFileSync(join(paths.secrets, 'encryption_key'))).toThrow();
  });
});

describe('backup generation', () => {
  it('refuses to certify an exported backup after another app start', async () => {
    const { initializeState, recordBackup } = await import('../scripts/local-state.mjs');
    const paths = fixture(); initializeState(paths);
    const stateFile = join(paths.secrets, 'version.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    writeFileSync(stateFile, JSON.stringify({ ...state, backupCandidate: state.generation }));
    recordBackup(paths, true);
    initializeState(paths);
    expect(() => recordBackup(paths, true)).toThrow(/another backup/i);
  });
});

describe('actionable launch failures', () => {
  it.each([
    ['pull', 'Could not download release images'],
    ['up', 'settings.env'],
  ])('explains %s failure without requesting setup credentials', async (failure, message) => {
    const { copyFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const root = mkdtempSync(join(tmpdir(), 'miracle failure ')); folders.push(root);
    for (const name of ['common.sh', 'start.sh', 'compose.yaml']) copyFileSync(fileURLToPath(new URL(`../release/${name}`, import.meta.url)), join(root, name));
    writeFileSync(join(root, 'docker'), '#!/bin/sh\ncase "$*" in *"pull app"*) [ "$FAIL_STAGE" != pull ];; *"up -d"*) echo "port is already allocated" >&2; exit 1;; *"setup-link"*) echo "UNEXPECTED SETUP"; exit 1;; *) exit 0;; esac\n', { mode: 0o755 });
    const result = spawnSync('sh', [join(root, 'start.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, FAIL_STAGE: failure } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain('UNEXPECTED SETUP');
  });
});
