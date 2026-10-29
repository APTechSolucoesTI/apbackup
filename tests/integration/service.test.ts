import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  new URL(url).hostname !== '127.0.0.1'
)
  throw new Error('Isolated test database required');

test('reports actual database health and a human-safe failure without exposing a connection string', async () => {
  const path = new URL('../../packages/db/src/health.ts', import.meta.url);
  const api: Record<string, unknown> = existsSync(path) ? await import(path.href) : {};
  expect(api.startCatalogHealthServer, 'startCatalogHealthServer must be implemented').toBeTypeOf(
    'function',
  );
  const { startCatalogHealthServer } = await import('../../packages/db/src/health.js');
  const { createDatabase, migrate } = await import('../../packages/db/src/index.js');
  const db = createDatabase(url);
  await migrate(db);
  const service = await startCatalogHealthServer(db, 0);
  let closed = false;
  try {
    const response = await fetch(`${service.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: 'apbackup-catalog',
      database: 'ready',
      migrations: 7,
    });
    expect((await fetch(`${service.url}/servers`)).status).toBe(404);
    await db.close();
    closed = true;
    const unavailable = await fetch(`${service.url}/health`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      service: 'apbackup-catalog',
      database: 'unavailable',
    });
  } finally {
    await service.close();
    if (!closed) await db.close();
  }
});
