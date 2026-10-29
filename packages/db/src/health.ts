import { createServer } from 'node:http';
import type { PlatformDatabase } from './client.js';

/** Local bootstrap harness, replaced/extended by the application in Task 3. */
export async function startCatalogHealthServer(db: PlatformDatabase, port = 4310) {
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end(JSON.stringify({ message: 'Rota não encontrada.' }));
      return;
    }
    try {
      const result = await db.pool.query<{ count: string }>(
        'SELECT count(*) FROM platform_migrations',
      );
      response.writeHead(200).end(
        JSON.stringify({
          service: 'apbackup-catalog',
          database: 'ready',
          migrations: Number(result.rows[0]?.count ?? 0),
        }),
      );
    } catch {
      response
        .writeHead(503)
        .end(JSON.stringify({ service: 'apbackup-catalog', database: 'unavailable' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Local service did not bind to a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
