import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
await mkdir('test-results/linux-runtime', { recursive: true });
await build({
  entryPoints: [
    process.argv.includes('--docker-eligibility')
      ? 'tests/linux/docker-eligibility.test.ts'
      : 'tests/linux/runtime.test.ts',
  ],
  outfile: 'test-results/linux-runtime/runtime.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['pg-native'],
  banner: {
    js: "import {createRequire as _createRequire} from 'node:module';const require=_createRequire(import.meta.url);",
  },
});
const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network=none',
    '--mount',
    `type=bind,source=${resolve('test-results/linux-runtime')},target=/tests,readonly`,
    'node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20',
    'node',
    '--test',
    '/tests/runtime.mjs',
  ],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
