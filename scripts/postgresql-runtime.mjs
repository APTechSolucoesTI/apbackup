import { createRequire } from 'node:module';
import { mkdir, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  throw new Error('Only disposable databases are allowed');
const require = createRequire(import.meta.url),
  { build } = createRequire(require.resolve('tsx'))('esbuild');
await import('./build-agent.mjs');
const directory = resolve('test-results/postgresql-runtime');
await mkdir(resolve(directory, 'source'), { recursive: true });
await cp('packages/db/migrations', resolve(directory, 'migrations'), { recursive: true });
await build({
  entryPoints: [
    process.argv.includes('--backends')
      ? 'tests/linux/repository-backends.test.ts'
      : process.argv.includes('--destinations')
        ? 'tests/linux/destination-flow.test.ts'
        : process.argv.includes('--schemas')
          ? 'tests/linux/schema-flow.test.ts'
          : 'tests/linux/postgresql-flow.test.ts',
  ],
  outfile: resolve(directory, 'source/flow.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['pg-native'],
  banner: {
    js: "import {createRequire as _createRequire} from 'node:module';const require=_createRequire(import.meta.url);",
  },
});
function docker(args, inherit = false) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr ?? ''}`);
  return result.stdout?.trim();
}
docker(
  ['build', '-f', 'apps/agent/Dockerfile.postgresql', '-t', 'apbackup-postgresql-runtime:17', '.'],
  true,
);
const name = 'apbackup-pg-flow-' + randomUUID(),
  database = 'apbackup_test_' + randomBytes(8).toString('hex'),
  password = randomBytes(24).toString('hex');
let started = false;
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'apbackup.disposable-test=true',
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    'postgres:17',
  ]);
  started = true;
  const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new pg.Client({
      host: '127.0.0.1',
      port: Number(port),
      user: 'postgres',
      password,
      database,
      connectionTimeoutMillis: 1000,
    });
    try {
      await client.connect();
      await client.query('select 1');
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await client.end().catch(() => {});
    }
  }
  if (!ready) throw new Error('Disposable PostgreSQL not ready');
  docker(
    [
      'run',
      '--rm',
      '--network',
      `container:${name}`,
      '--mount',
      `type=bind,source=${directory},target=/tests,readonly`,
      '--mount',
      `type=bind,source=${resolve('../.superpowers/sdd/2026-10-28-backup-platform/tools/linux-amd64')},target=/tools,readonly`,
      '-e',
      `TEST_DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:5432/${database}`,
      'apbackup-postgresql-runtime:17',
      '--test',
      '/tests/source/flow.mjs',
    ],
    true,
  );
} finally {
  if (started) docker(['rm', '-fv', name]);
}
