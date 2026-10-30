import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  throw new Error('Only disposable databases are allowed');
const require = createRequire(import.meta.url),
  { build } = createRequire(require.resolve('tsx'))('esbuild');
const directory = resolve('test-results/postgresql-docker-runtime');
await mkdir(directory, { recursive: true });
await build({
  entryPoints: ['tests/linux/postgresql-docker-flow.test.ts'],
  outfile: resolve(directory, 'flow.mjs'),
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
  if (result.status !== 0)
    throw new Error(`Disposable Docker ${args[0]} failed: ${result.stderr ?? ''}`);
  return result.stdout?.trim();
}
const name = 'apbackup-pg-local-test-' + randomUUID();
let started = false;
function removeDisposable() {
  const label = docker([
    'inspect',
    '--format',
    '{{index .Config.Labels "apbackup.disposable-test"}}',
    name,
  ]);
  if (label !== 'true') throw new Error('Disposable ownership changed');
  docker(['rm', '-fv', name]);
}
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'apbackup.disposable-test=true',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:17',
  ]);
  started = true;
  let ready = false;
  for (let n = 0; n < 60; n++) {
    const probe = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error('Disposable PostgreSQL not ready');
  docker(
    [
      'run',
      '--rm',
      '--mount',
      'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount',
      `type=bind,source=${directory},target=/tests,readonly`,
      '-e',
      `TEST_PG_CONTAINER=${name}`,
      'apbackup-postgresql-runtime:17',
      '--test',
      '/tests/flow.mjs',
    ],
    true,
  );
} finally {
  if (started) removeDisposable();
}
