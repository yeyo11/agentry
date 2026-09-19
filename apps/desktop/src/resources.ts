import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';

export interface Resources {
  /** Bundled API server (single-file ESM) */
  serverEntry: string;
  /** Built UI served by the API */
  webDist: string;
  /** Window icon */
  icon: string;
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
      icon: join(process.resourcesPath, 'icon.png'),
    };
  }
  const repoRoot = resolve(__dirname, '..', '..', '..');
  return {
    serverEntry: join(repoRoot, 'apps', 'api', 'dist', 'server.mjs'),
    webDist: join(repoRoot, 'apps', 'web', 'dist'),
    icon: join(repoRoot, 'apps', 'desktop', 'build', 'icon.png'),
  };
}

/** Names what is absent so a broken build or package fails with a readable message */
export function missingResources(res: Resources): string[] {
  const missing: string[] = [];
  if (!existsSync(res.serverEntry)) missing.push(res.serverEntry);
  if (!existsSync(join(res.webDist, 'index.html'))) missing.push(join(res.webDist, 'index.html'));
  return missing;
}
