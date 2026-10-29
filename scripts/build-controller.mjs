import { createRequire } from 'node:module';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
await build({
  entryPoints: {
    coordinator: 'apps/coordinator/src/main.ts',
    migrate: 'packages/db/src/cli.ts',
    administrator: 'scripts/bootstrap-admin.ts',
  },
  outdir: 'dist/controller',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['pg-native'],
  banner: {
    js: "import {createRequire as _createRequire} from 'node:module';const require=_createRequire(import.meta.url);",
  },
});
// migrate() resolves ../migrations relative to the emitted CLI.
await mkdir('dist/migrations', { recursive: true });
for (const name of await readdir('packages/db/migrations')) {
  if (/^\d+_[a-z0-9_]+\.sql$/.test(name))
    await copyFile(`packages/db/migrations/${name}`, `dist/migrations/${name}`);
}
