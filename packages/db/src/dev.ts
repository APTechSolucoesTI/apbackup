import { createDatabase } from './client.js';
import { startCatalogHealthServer } from './health.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Configure DATABASE_URL in .env before starting the local catalog.');
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535');
const db = createDatabase(url);
try {
  // Startup/watch is read-only. Apply finalized migrations explicitly with db:migrate.
  const readiness = await db.pool.query('SELECT name FROM platform_migrations LIMIT 1');
  if (readiness.rowCount === 0) throw new Error('Catalog migrations must be applied first');
  const service = await startCatalogHealthServer(db, port);
  console.log(`Catálogo local: ${service.url}/health (harness de banco, sem interface web).`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    await db.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
} catch {
  console.error(
    'Não foi possível iniciar o catálogo local. Verifique o banco, a configuração e execute db:migrate antes de iniciar.',
  );
  await db.close();
  process.exitCode = 1;
}
