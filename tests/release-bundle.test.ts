import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

it('packages only the local launcher allowlist and fixed public image reference', () => {
  const output = mkdtempSync(join(tmpdir(), 'miracle release проверка '));
  try {
    execFileSync(process.execPath, ['scripts/build-release.mjs', 'Example/Miracle', '1.2.3', output], { cwd: resolve(import.meta.dirname, '..') });
    const zip = join(output, 'miracle-1.2.3.zip');
    const files = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').filter(name => !name.endsWith('/')).map(name => name.replace('miracle-1.2.3/', '')).sort();
    expect(files).toEqual(['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'backup.cmd', 'backup.sh', 'common.sh', 'compose.yaml', 'local.ps1', 'restore.cmd', 'restore.sh', 'settings.env', 'start.cmd', 'start.sh', 'stop.cmd', 'stop.sh'].sort());
    const compose = execFileSync('unzip', ['-p', zip, 'miracle-1.2.3/compose.yaml'], { encoding: 'utf8' });
    expect(compose).toContain('ghcr.io/example/miracle:1.2.3');
    expect(compose).not.toMatch(/__REPOSITORY__|__VERSION__|build:/);
    expect(compose).toContain('name: miracle-local');
    const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
    expect(readFileSync(`${zip}.sha256`, 'utf8')).toBe(`${digest}  miracle-1.2.3.zip\n`);
  } finally { rmSync(output, { recursive: true, force: true }); }
});
