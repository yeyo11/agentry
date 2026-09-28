import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CswapInstallState } from '@agentry/shared';
import { CSWAP_VERSION, UV_VERSION, uvAsset, type UvAsset } from './cswap-pin.ts';

/** uv also fetches a standalone Python when the system has no 3.12, which is the slow part */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface CswapInstallerOptions {
  fetch?: typeof fetch;
  /** The uv archive to install from; null where this platform has no pinned build */
  asset?: UvAsset | null;
  /** The claude-swap version to install */
  version?: string;
  env?: NodeJS.ProcessEnv;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n').slice(-5).join('\n').slice(0, 500)));
      else resolve(stdout);
    });
  });
}

/**
 * Installs the pinned claude-swap into Agentry's own data directory, so multiple accounts work on a
 * machine where nobody installed it by hand. uv comes from a pinned release whose digest is checked
 * before it ever runs, and every path uv writes to is inside the tools directory: nothing lands in
 * the user's `~/.local`. claude-swap's own data (the accounts) lives elsewhere and is never touched.
 */
export class CswapInstaller {
  readonly dir: string;
  readonly bin: string;
  readonly asset: UvAsset | null;
  private readonly version: string;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private running: Promise<void> | null = null;
  private failure: string | null = null;
  step: 'uv' | 'claude-swap' | undefined;

  constructor(dataDir: string, opts: CswapInstallerOptions = {}) {
    this.dir = join(dataDir, 'tools');
    this.bin = join(this.dir, 'bin', 'cswap');
    this.asset = opts.asset === undefined ? uvAsset() : opts.asset;
    this.version = opts.version ?? CSWAP_VERSION;
    this.fetchImpl = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
  }

  get state(): CswapInstallState {
    if (this.running) return 'installing';
    if (this.failure) return 'failed';
    return existsSync(this.bin) ? 'installed' : 'absent';
  }

  get error(): string | undefined {
    return this.running ? undefined : (this.failure ?? undefined);
  }

  /** Starts the install, or joins the one already running. Resolves when it ends; never rejects. */
  install(): Promise<void> {
    this.running ??= this.perform()
      .then(() => {
        this.failure = null;
      })
      .catch((err: unknown) => {
        this.failure = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.running = null;
        this.step = undefined;
      });
    return this.running;
  }

  private async perform(): Promise<void> {
    if (!this.asset) throw new Error(`no pinned uv build for ${process.platform}-${process.arch}`);
    this.failure = null;
    this.step = 'uv';
    const uv = await this.uv(this.asset);

    this.step = 'claude-swap';
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      UV_TOOL_DIR: join(this.dir, 'tools'),
      UV_TOOL_BIN_DIR: join(this.dir, 'bin'),
      UV_PYTHON_INSTALL_DIR: join(this.dir, 'python'),
      UV_PYTHON_BIN_DIR: join(this.dir, 'python-bin'),
      UV_CACHE_DIR: join(this.dir, 'cache'),
      // The user's uv.toml must not move the install somewhere else, or pick another index
      UV_NO_CONFIG: '1',
    };
    await run(uv, ['tool', 'install', '--force', `claude-swap==${this.version}`], env, INSTALL_TIMEOUT_MS);

    const reported = (await run(this.bin, ['--version'], this.env, 15_000)).trim().split(/\s+/).at(-1);
    if (reported !== this.version) throw new Error(`installed claude-swap reports ${reported ?? 'no version'}, expected ${this.version}`);
  }

  /** The pinned uv, downloaded once and verified before it runs. */
  private async uv(asset: UvAsset): Promise<string> {
    const home = join(this.dir, `uv-${UV_VERSION}`);
    const bin = join(home, asset.dir, 'uv');
    if (existsSync(bin)) return bin;
    const res = await this.fetchImpl(asset.url);
    if (!res.ok) throw new Error(`downloading uv failed: HTTP ${res.status}`);
    const archive = Buffer.from(await res.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== asset.sha256) throw new Error(`uv archive digest mismatch: got ${digest}, expected ${asset.sha256}`);
    await mkdir(home, { recursive: true });
    const file = join(home, 'uv.tar.gz');
    await writeFile(file, archive);
    try {
      await run('tar', ['-xzf', file, '-C', home], this.env, 60_000);
    } finally {
      await rm(file, { force: true });
    }
    if (!existsSync(bin)) throw new Error('the uv archive did not contain uv');
    return bin;
  }

  /** Deletes the managed copy, uv and its cache. The accounts live in claude-swap's own data dir. */
  async remove(): Promise<void> {
    if (this.running) throw Object.assign(new Error('claude-swap is being installed'), { statusCode: 409 });
    await rm(this.dir, { recursive: true, force: true });
    this.failure = null;
  }
}
