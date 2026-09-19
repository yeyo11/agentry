// Compiles the Electron main and preload processes into dist/. Both are CommonJS: a sandboxed preload
// cannot be ESM, and Electron's main works the same with either. `electron` is provided by the runtime.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: { main: `${root}src/main.ts`, preload: `${root}src/preload.ts` },
  outdir: `${root}dist`,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
