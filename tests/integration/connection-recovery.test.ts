import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';

test('survives loss of an idle PostgreSQL connection and reconnects without dumping private client state', async () => {
  const factory = new URL('../../packages/db/src/client.ts', import.meta.url).href;
  const health = new URL('../../packages/db/src/health.ts', import.meta.url).href;
  const migration = new URL('../../packages/db/src/migrate.ts', import.meta.url).href;
  const source = `
    import pg from 'pg';
    import { createDatabase } from ${JSON.stringify(factory)};
    import { startCatalogHealthServer } from ${JSON.stringify(health)};
    import { migrate } from ${JSON.stringify(migration)};
    const url = process.env.TEST_DATABASE_URL;
    if (!url || !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1)) || new URL(url).hostname !== '127.0.0.1') throw new Error('Unsafe test database');
    const db = createDatabase(url);
    const admin = new pg.Client({ connectionString: url });
    let service;
    try {
      await admin.connect();
      await migrate(db);
      service = await startCatalogHealthServer(db, 0);
      const before = await fetch(service.url + '/health');
      if (before.status !== 200) throw new Error('Initial health failed');
      const result = await db.pool.query('SELECT pg_backend_pid() as pid');
      // All role changes affect ONLY the random-password, disposable test cluster.
      // Keep this admin session connected so it can restore login after the probe.
      await admin.query('ALTER ROLE postgres NOLOGIN');
      await admin.query('SELECT pg_terminate_backend($1)', [result.rows[0].pid]);
      // Allow the socket termination to arrive while the pool client is idle.
      await new Promise(resolve => setTimeout(resolve, 100));
      const unavailable = await fetch(service.url + '/health');
      if (unavailable.status !== 503 || JSON.stringify(await unavailable.json()) !== JSON.stringify({ service: 'apbackup-catalog', database: 'unavailable' })) throw new Error('Safe offline health failed');
      await admin.query('ALTER ROLE postgres LOGIN');
      const recovered = await fetch(service.url + '/health');
      if (recovered.status !== 200) throw new Error('Health did not recover');
      console.log('health:200,503,200');
    } finally {
      await admin.query('ALTER ROLE postgres LOGIN');
      if (service) await service.close();
      await db.close(); await admin.end();
    }
  `;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source],
        { env: process.env },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    },
  );
  expect(result.code, 'idle database disconnect must not crash the service').toBe(0);
  expect(result.stdout).toContain('health:200,503,200');
  expect(result.stderr).not.toContain('connectionParameters');
  expect(result.stderr).not.toContain('secretKey');
  expect(result.stderr).not.toContain('postgresql://');
  const password = new URL(process.env.TEST_DATABASE_URL!).password;
  expect(result.stderr.includes(password), 'database password must never be logged').toBe(false);
});
