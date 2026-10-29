import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createDatabase } from '../../packages/db/src/index.js';

test('dev startup refuses an uninitialized catalog without applying migration drafts', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    !url ||
    !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1)) ||
    new URL(url).hostname !== '127.0.0.1'
  )
    throw new Error('Isolated test database required');
  const admin = createDatabase(url);
  const name = `apbackup_test_${randomBytes(16).toString('hex')}`;
  const freshUrl = new URL(url);
  freshUrl.pathname = `/${name}`;
  // Identifier is generated locally from a fixed prefix and random hex, never user input.
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const fresh = createDatabase(freshUrl.href);
  const entrypoint = new URL('../../packages/db/src/dev.ts', import.meta.url);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(entrypoint)], {
    env: { ...process.env, TEST_DATABASE_URL: freshUrl.href, PORT: '4313' },
  });
  try {
    const outcome = await new Promise<{ state: 'started' | 'exited'; code?: number | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Dev startup probe timed out')), 10000);
        child.stdout.on('data', (data: Buffer) => {
          if (data.toString().includes('Catálogo local:')) {
            clearTimeout(timeout);
            resolve({ state: 'started' });
          }
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          resolve({ state: 'exited', code });
        });
      },
    );
    expect(outcome).toEqual({ state: 'exited', code: 1 });
    const ledger = await fresh.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.platform_migrations')::text AS name",
    );
    expect(ledger.rows[0]?.name).toBeNull();
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await fresh.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});
