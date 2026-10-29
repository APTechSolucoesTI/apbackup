import { getAuthRuntime } from './lib/runtime.server.js';
import { createAuthHttpServer } from './http.server.js';
const runtime = getAuthRuntime();
const port = Number(new URL(process.env.AUTH_BASE_URL!).port || 4311);
try {
  // Never auto-apply migration drafts when starting/watch-restarting a server.
  await runtime.db.pool.query('select id from auth_sessions limit 0');
  const server = createAuthHttpServer(runtime.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`API local de autenticação: http://127.0.0.1:${port}/api/session`);
  const stop = () => {
    server.close(() => {
      void runtime.db.close();
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch {
  console.error(
    'Não foi possível iniciar a autenticação. Confira a configuração e aplique db:migrate.',
  );
  await runtime.db.close();
  process.exitCode = 1;
}
