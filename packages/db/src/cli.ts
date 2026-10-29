import { createDatabase } from './client.js';
import { migrate } from './migrate.js';

if (!process.env.DATABASE_URL)
  throw new Error('Configure DATABASE_URL before applying catalog migrations');
const db = createDatabase(process.env.DATABASE_URL);
try {
  await migrate(db);
  console.log('Migrations do catálogo aplicadas.');
} catch {
  console.error(
    'Falha ao aplicar migrations. Verifique acesso, integridade e configuração do catálogo.',
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
