import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreConfig } from './paths.ts';

const NAME_RE = /^[\w][\w.-]{0,63}$/;
const GIT_URL_RE = /^(https:\/\/|ssh:\/\/|git@)[\w.@:/~+-]+$/;
const CLONE_TIMEOUT_MS = 180_000;

/** Same encoding the CLI uses for directory names under ~/.claude/projects. */
export function encodeProjectId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Creates the directories of the wrapper workspace (the default cwd for runs). */
export class Workspace {
  constructor(private readonly config: CoreConfig) {}

  /** Creates an empty project directory, or clones `gitUrl` into it. Returns the absolute path. */
  async create(name: string, gitUrl?: string): Promise<string> {
    if (!NAME_RE.test(name ?? '')) throw new Error('invalid project name (letters, digits, _ . - only)');
    const path = join(this.config.workspaceDir, name);
    if (existsSync(path)) throw new Error(`project '${name}' already exists`);
    if (!gitUrl) {
      await mkdir(path, { recursive: true });
      return path;
    }
    if (!GIT_URL_RE.test(gitUrl)) throw new Error('invalid git url (https://, ssh:// or git@ only)');
    await new Promise<void>((resolvePromise, reject) => {
      execFile(
        'git',
        ['clone', '--', gitUrl, path],
        { timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (error, _stdout, stderr) => (error ? reject(new Error(`git clone failed: ${stderr.trim() || error.message}`)) : resolvePromise()),
      );
    });
    return path;
  }
}
