import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('.local', {recursive:true, mode:0o700});
try {
  await writeFile('.local/encryption.key', randomBytes(32).toString('hex'), {flag:'wx', mode:0o600});
  console.log('Created .local/encryption.key; keep it with your backups.');
} catch (error) { if(error.code !== 'EEXIST') throw error; console.log('Preserved existing encryption key.'); }
