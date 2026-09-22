import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { buildServiceWorker } from './scripts/sw-shell.ts';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8787';

/** Files of `public/` the shell needs; the icons are not among them, the platform fetches those. */
const STATIC_SHELL = ['/favicon.svg', '/manifest.webmanifest'];

/**
 * Fills in the service worker's asset list after the bundle is written.
 *
 * What index.html asks for before it can paint — the entry module, its preloaded chunks, the
 * stylesheet — is exactly the app shell, so the list is read back from the built page rather than
 * guessed from the chunk graph. The fonts are added by extension: nothing in the HTML references
 * them, the stylesheet does, and a shell that repaints in a fallback font is not a cold start.
 */
function serviceWorkerShell(): Plugin {
  let dist = '';
  let publicDir = '';
  return {
    name: 'agentry:service-worker-shell',
    apply: 'build',
    configResolved(config) {
      dist = resolve(config.root, config.build.outDir);
      publicDir = config.publicDir;
    },
    // closeBundle, not writeBundle: Vite copies public/ over dist/ as part of writing the bundle,
    // and this has to be the last word on dist/sw.js rather than the copy of the placeholder.
    closeBundle() {
      const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
      const referenced = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].flatMap(([, path]) => (path ? [path] : []));
      const fonts = readdirSync(resolve(dist, 'assets'))
        .filter((name) => name.endsWith('.woff2'))
        .map((name) => `/assets/${name}`);
      const worker = buildServiceWorker(readFileSync(resolve(publicDir, 'sw.js'), 'utf8'), ['/index.html', ...STATIC_SHELL, ...referenced, ...fonts], html);
      writeFileSync(resolve(dist, 'sw.js'), worker);
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorkerShell()],
  server: {
    port: 5173,
    proxy: {
      // API reference (Scalar) and its OpenAPI document are served by the API
      '/docs': { target: API_TARGET, changeOrigin: true },
      '/openapi.json': { target: API_TARGET, changeOrigin: true },
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // SSE: long-lived responses must never time out or be buffered/transformed.
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // CodeMirror lives in its own lazy chunk (~220 kB gzip); it is only fetched by editor screens
    chunkSizeWarningLimit: 700,
  },
});
