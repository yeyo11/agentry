import { join } from 'node:path';
import type { ConfigFileVariant } from '@agentry/shared';
import type { CoreConfig } from '../paths.ts';

/** Where a piece of configuration lives: the account-wide Claude config dir, or one project. */
export type ConfigScope =
  | { kind: 'user'; claudeDir: string }
  | { kind: 'project'; projectPath: string; claudeDir: string };

export function userScope(config: CoreConfig): ConfigScope {
  return { kind: 'user', claudeDir: config.configDir };
}

export function projectScope(projectPath: string): ConfigScope {
  return { kind: 'project', projectPath, claudeDir: join(projectPath, '.claude') };
}

export function parseVariant(value: unknown): ConfigFileVariant {
  if (value === undefined || value === '' || value === 'shared') return 'shared';
  if (value === 'local') return 'local';
  throw new Error("variant must be 'shared' or 'local'");
}

function requireProjectForLocal(scope: ConfigScope, variant: ConfigFileVariant): void {
  if (variant === 'local' && scope.kind !== 'project') throw new Error("variant 'local' only exists in project scope");
}

export function settingsPath(scope: ConfigScope, variant: ConfigFileVariant): string {
  requireProjectForLocal(scope, variant);
  return join(scope.claudeDir, variant === 'local' ? 'settings.local.json' : 'settings.json');
}

export function instructionsPath(scope: ConfigScope, variant: ConfigFileVariant): string {
  requireProjectForLocal(scope, variant);
  if (scope.kind === 'user') return join(scope.claudeDir, 'CLAUDE.md');
  return join(scope.projectPath, variant === 'local' ? 'CLAUDE.local.md' : 'CLAUDE.md');
}
