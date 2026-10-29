import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

// Never accept a caller-supplied database for destructive test setup.
if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
  throw new Error(
    'Tests manage their own disposable PostgreSQL. Unset TEST_DATABASE_URL and DATABASE_URL.',
  );
}
const name = `apbackup-test-${randomUUID()}`;
const database = `apbackup_test_${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('hex');
function docker(args, inherit = false) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.status !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr ?? result.error?.message ?? ''}`);
  return result.stdout?.trim();
}
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
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await client.end().catch(() => {});
    }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  const e2e = process.argv.includes('--e2e');
  const args = e2e
    ? [
        'exec',
        'playwright',
        'test',
        ...process.argv.slice(2).filter((arg) => !['--e2e', '--'].includes(arg)),
      ]
    : [
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.integration.config.ts',
        ...process.argv.slice(2).filter((arg) => arg !== '--'),
      ];
  const environment = { ...process.env, TEST_DATABASE_URL: url, TEST_POSTGRES_CONTAINER: name };
  // Playwright sets FORCE_COLOR for children; do not pass a conflicting NO_COLOR.
  if (e2e) delete environment.NO_COLOR;
  if (e2e) {
    // Explicit preparation of the disposable DB; dev/watch must never apply SQL drafts.
    const preparation = spawnSync(
      process.execPath,
      [process.env.npm_execpath, 'exec', 'tsx', 'packages/db/src/cli.ts'],
      {
        stdio: 'inherit',
        env: { ...environment, DATABASE_URL: url },
      },
    );
    if (preparation.status !== 0)
      throw new Error('Failed to prepare the disposable HTTP test catalog');
  }
  console.log(
    `Isolated PostgreSQL ready (${database}, loopback only). Running ${e2e ? 'HTTP smoke' : 'integration tests'}.`,
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {
      stdio: 'inherit',
      env: environment,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = result;
} finally {
  if (started) docker(['rm', '-fv', name]);
}
