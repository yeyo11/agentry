// Compiles the API into self-contained ESM files under dist/, one per entrypoint:
//   server.mjs  the child process the desktop app spawns (src/standalone.ts)
//   api.mjs     the long-lived service the container starts (src/index.ts)
// Only node: builtins stay external (node:sqlite among them), so neither file needs node_modules,
// a source tree or a transpiler beside it.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  // Both outputs repeat the code they share on purpose: splitting would emit a chunk beside them,
  // and each one ships alone (electron-builder copies server.mjs, the image copies api.mjs).
  entryPoints: { server: `${root}src/standalone.ts`, api: `${root}src/index.ts` },
  outdir: `${root}dist`,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some CJS dependencies call require(); ESM output has none, so provide one
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
