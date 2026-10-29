import { pathToFileURL } from 'node:url';
import { createDatabase } from '@apbackup/db';
import { runCoordinator } from './coordinator.js';
export { coordinatorTick, runCoordinator } from './coordinator.js';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL');
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    await runCoordinator(db, controller.signal, {
      schedules: process.env.COORDINATOR_SCHEDULES === 'enabled',
      once: process.argv.includes('--once'),
    });
  } finally {
    await db.close();
  }
}
