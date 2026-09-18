// Bundles the API (workspace packages and npm dependencies included) into a single ESM file,
// dist/server.mjs, that runs with plain `node` and no node_modules next to it.
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist/server.mjs');

rmSync(resolve(root, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, 'src/standalone.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node:sqlite and friends stay builtins
  external: ['node:*'],
  // CommonJS dependencies (fastify and its plugins) call require(), which ESM output lacks
  banner: {
    js: "import { createRequire as __agentryCreateRequire } from 'node:module'; const require = __agentryCreateRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
});
