import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';

export interface Resources {
  /** Bundled API server (single-file ESM); permission-mcp.mjs must sit next to it */
  serverEntry: string;
  /** Built UI served by the API */
  webDist: string;
}

/**
 * Packaged: electron-builder extraResources put the bundle in <resources>/server and the UI in <resources>/web.
 * Dev: the compiled main lives in apps/desktop/dist, so the repo root is three levels up.
 */
export function resolveResources(): Resources {
  if (app.isPackaged) {
    return {
      serverEntry: join(process.resourcesPath, 'server', 'server.mjs'),
      webDist: join(process.resourcesPath, 'web'),
    };
  }
  const repoRoot = resolve(__dirname, '..', '..', '..');
  return {
    serverEntry: join(repoRoot, 'apps', 'api', 'dist', 'server.mjs'),
    webDist: join(repoRoot, 'apps', 'web', 'dist'),
  };
}

/** Names what is absent so a broken build or package fails with a readable message */
export function missingResources(res: Resources): string[] {
  const missing: string[] = [];
  if (!existsSync(res.serverEntry)) missing.push(res.serverEntry);
  if (!existsSync(join(res.serverEntry, '..', 'permission-mcp.mjs'))) missing.push(join(res.serverEntry, '..', 'permission-mcp.mjs'));
  if (!existsSync(join(res.webDist, 'index.html'))) missing.push(join(res.webDist, 'index.html'));
  return missing;
}
