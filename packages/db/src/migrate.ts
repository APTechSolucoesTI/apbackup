import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PlatformDatabase } from './client.js';

export async function migrate(db: PlatformDatabase): Promise<void> {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw new Error('No versioned platform migrations found');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Shared across all coordinator processes; lock and ledger are in one transaction.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('apbackup.platform.migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS platform_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of files) {
      const source = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const existing = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM platform_migrations WHERE name = $1',
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== checksum)
          throw new Error(`Applied migration ${name} changed; create a new migration instead`);
        continue;
      }
      await client.query(source);
      await client.query('INSERT INTO platform_migrations (name, sha256) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
