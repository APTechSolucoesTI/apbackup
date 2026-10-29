import { createDatabase } from '@apbackup/db';
import { createAuth } from './auth.server.js';
import { createSessionService } from './session.server.js';
import { createAuthApi } from './api.server.js';
import { createConsoleApi } from './console.server.js';
import { createConfigurationApi } from './configuration.server.js';
import { createRuntimeApi } from './execution.server.js';
import { createPostgresApi } from './postgresql.server.js';
import { createDockerApi } from './docker.server.js';
import { createDokployApi } from './dokploy.server.js';
let runtime: ReturnType<typeof initialize> | undefined;
function initialize() {
  const databaseURL = process.env.DATABASE_URL;
  const secret = process.env.AUTH_SECRET;
  const baseURL = process.env.AUTH_BASE_URL;
  if (!databaseURL || !secret || !baseURL)
    throw new Error('Configure DATABASE_URL, AUTH_SECRET and AUTH_BASE_URL');
  const db = createDatabase(databaseURL);
  const auth = createAuth({
    db,
    secret,
    baseURL,
    production: process.env.NODE_ENV === 'production',
  });
  const sessions = createSessionService(auth, db);
  return {
    db,
    auth,
    sessions,
    executionHandler: createRuntimeApi(db, sessions.requireSession, baseURL),
    postgresHandler: createPostgresApi(db, sessions.requireSession, baseURL),
    dockerHandler: createDockerApi(db, sessions.requireSession, baseURL),
    dokployHandler: createDokployApi(db, sessions.requireSession, baseURL),
    handler: createAuthApi(auth, db),
    consoleHandler: createConsoleApi(auth, db),
    configurationHandler: createConfigurationApi(auth, db),
  };
}
export function getAuthRuntime() {
  return (runtime ??= initialize());
}
export async function requireSession(request: Request) {
  return getAuthRuntime().sessions.requireSession(request);
}
