import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export function createDatabase(url: string) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.pathname.slice(1))
    throw new Error('A PostgreSQL database URL is required');
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  // Idle connections can fail outside a query after a database restart. pg evicts
  // the failed client; consuming this event keeps the process alive for reconnect.
  // Never print the raw error: pg can attach connection internals and credentials.
  pool.on('error', () => {
    console.error(
      'Conexão ociosa com o catálogo interrompida; a próxima consulta tentará reconectar.',
    );
  });
  const orm = drizzle(pool, { schema });
  return { pool, orm, close: () => pool.end() };
}
export type PlatformDatabase = ReturnType<typeof createDatabase>;
