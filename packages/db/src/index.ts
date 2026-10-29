// Server-only package. Browser applications must import @apbackup/contracts instead.
export { createDatabase } from './client.js';
export type { PlatformDatabase } from './client.js';
export { migrate } from './migrate.js';
export * as schema from './schema.js';
