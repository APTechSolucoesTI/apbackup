import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
await build({
  entryPoints: ['apps/agent/src/main.ts'],
  outfile: 'dist/agent/agent.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['pg-native'],
  banner: {
    js: "import {createRequire as _createRequire} from 'node:module';const require=_createRequire(import.meta.url);",
  },
});
