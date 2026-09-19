// Bundles the API into a single self-contained ESM file for the desktop app: dist/server.mjs.
// Only node: builtins stay external (node:sqlite among them), so nothing from node_modules has to ship alongside.
// The one exception is permission-mcp.mjs: core spawns it as a separate `node` process resolved relative to
// import.meta.url, which inside the bundle is dist/, so it is copied next to server.mjs.
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/standalone.ts`],
  outfile: `${root}dist/server.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some CJS dependencies call require(); ESM output has none, so provide one
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

copyFileSync(fileURLToPath(new URL('../../../packages/core/src/permission-mcp.mjs', import.meta.url)), `${root}dist/permission-mcp.mjs`);
