import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url),
  { build } = createRequire(require.resolve('tsx'))('esbuild'),
  directory = resolve('test-results/swarm-runtime');
await mkdir(directory, { recursive: true });
await build({
  entryPoints: ['tests/linux/swarm-flow.test.ts'],
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
const docker = (args, inherit = false) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  if (r.status !== 0) throw new Error(`Docker ${args[0]} failed: ${r.stderr ?? ''}`);
  return r.stdout?.trim();
};
const name = 'apbackup-swarm-fixture-' + randomUUID(),
  socket = 'apbackup-swarm-socket-' + randomUUID();
let started = false;
try {
  docker(['volume', 'create', '--label', 'apbackup.disposable-test=true', socket]);
  docker(['save', '-o', resolve(directory, 'helper.tar'), 'node:24.21.0-bookworm-slim']);
  docker([
    'run',
    '-d',
    '--privileged',
    '--name',
    name,
    '--label',
    'apbackup.disposable-test=true',
    '-e',
    'DOCKER_TLS_CERTDIR=',
    '--mount',
    `type=volume,source=${socket},target=/var/run`,
    'docker:27-dind',
    'dockerd',
    '--host=unix:///var/run/docker.sock',
  ]);
  started = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'docker', 'info'], { stdio: 'ignore' }).status === 0) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error('Isolated daemon unavailable');
  docker(['cp', resolve(directory, 'helper.tar'), `${name}:/helper.tar`]);
  docker(['exec', name, 'docker', 'load', '-i', '/helper.tar']);
  const image = docker([
    'exec',
    name,
    'docker',
    'image',
    'inspect',
    'node:24.21.0-bookworm-slim',
    '--format',
    '{{.Id}}',
  ]);
  try {
    docker(
      [
        'run',
        '--rm',
        '--network',
        `container:${name}`,
        '--mount',
        `type=volume,source=${socket},target=/daemon`,
        '--mount',
        `type=bind,source=${directory},target=/tests,readonly`,
        '-e',
        `FIXTURE_HELPER_IMAGE=${image}`,
        'apbackup-postgresql-runtime:17',
        '--test',
        '/tests/flow.mjs',
      ],
      true,
    );
  } catch (e) {
    const ids = docker(['exec', name, 'docker', 'service', 'ls', '-q']).split('\n').filter(Boolean);
    for (const id of ids)
      console.error(docker(['exec', name, 'docker', 'service', 'ps', '--no-trunc', id]));
    throw e;
  }
} finally {
  if (started) docker(['rm', '-fv', name]);
  docker(['volume', 'rm', socket]);
}
