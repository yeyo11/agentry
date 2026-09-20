import type { AvailablePlugin, CliTextResult, InstalledPlugin, PluginMarketplace, PluginScope, PluginsOverview } from '@agentry/shared';
import { execCli } from './cli.ts';
import type { CoreConfig } from './paths.ts';

// Identifiers end up as CLI arguments: they must never start with '-' or they would parse as flags
const PLUGIN_RE = /^[A-Za-z0-9][\w.-]{0,99}(@[A-Za-z0-9][\w.-]{0,99})?$/;
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,99}$/;
// GitHub owner/repo, URLs and filesystem paths; never something that parses as a CLI flag
const SOURCE_RE = /^[\w@/.~][\w@:/.~+%#=?&-]{0,500}$/;
const ACTION_TIMEOUT_MS = 180_000;
const AVAILABLE_TTL_MS = 5 * 60_000;
const MAX_AVAILABLE = 100;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Thin layer over `claude plugin …`: the CLI stays the owner of the plugin state. */
export class Plugins {
  private availableCache: { at: number; value: AvailablePlugin[] } | null = null;

  constructor(private readonly config: CoreConfig) {}

  private async json(args: string[]): Promise<unknown> {
    const res = await execCli(this.config, args, { timeoutMs: 60_000 });
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw new Error((res.stderr || res.stdout).trim().slice(0, 500) || `claude ${args.join(' ')} failed`);
    }
  }

  private async text(args: string[]): Promise<CliTextResult> {
    const res = await execCli(this.config, args, { timeoutMs: ACTION_TIMEOUT_MS });
    this.availableCache = null;
    return { ok: res.code === 0, output: [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join('\n') };
  }

  private toInstalled(raw: Record<string, unknown>): InstalledPlugin {
    const id = String(raw.id ?? '');
    const [name = id, marketplace = ''] = id.split('@');
    return {
      id,
      name,
      marketplace,
      version: str(raw.version),
      scope: str(raw.scope) ?? 'user',
      enabled: raw.enabled === true,
      installPath: str(raw.installPath),
      installedAt: str(raw.installedAt),
      lastUpdated: str(raw.lastUpdated),
    };
  }

  async overview(): Promise<PluginsOverview> {
    const [list, marketplaces] = await Promise.all([
      this.json(['plugin', 'list', '--json']),
      this.json(['plugin', 'marketplace', 'list', '--json']).catch(() => []),
    ]);
    // `list --json` is an array on some versions and `{ installed }` on others
    const installedRaw = Array.isArray(list) ? list : ((list as { installed?: unknown[] }).installed ?? []);
    return {
      installed: (installedRaw as Array<Record<string, unknown>>).map((p) => this.toInstalled(p)),
      marketplaces: ((Array.isArray(marketplaces) ? marketplaces : []) as Array<Record<string, unknown>>).map<PluginMarketplace>((m) => ({
        name: String(m.name ?? ''),
        source: String(m.source ?? ''),
        location: str(m.repo) ?? str(m.url) ?? str(m.path) ?? '',
      })),
    };
  }

  async available(query = ''): Promise<AvailablePlugin[]> {
    if (!this.availableCache || Date.now() - this.availableCache.at > AVAILABLE_TTL_MS) {
      const data = (await this.json(['plugin', 'list', '--json', '--available'])) as { installed?: unknown[]; available?: unknown[] };
      const installed = new Set(((data.installed ?? []) as Array<Record<string, unknown>>).map((p) => String(p.id)));
      this.availableCache = {
        at: Date.now(),
        value: ((data.available ?? []) as Array<Record<string, unknown>>).map((p) => ({
          pluginId: String(p.pluginId ?? ''),
          name: String(p.name ?? ''),
          description: String(p.description ?? ''),
          marketplaceName: String(p.marketplaceName ?? ''),
          version: str(p.version),
          installed: installed.has(String(p.pluginId ?? '')),
        })),
      };
    }
    const q = query.trim().toLowerCase();
    const all = this.availableCache.value;
    const matches = q ? all.filter((p) => `${p.name} ${p.description} ${p.marketplaceName}`.toLowerCase().includes(q)) : all;
    return matches.slice(0, MAX_AVAILABLE);
  }

  private plugin(plugin: unknown): string {
    if (typeof plugin !== 'string' || !PLUGIN_RE.test(plugin)) throw new Error("invalid plugin id (expected 'name' or 'name@marketplace')");
    return plugin;
  }

  private scopeArgs(scope?: PluginScope): string[] {
    if (scope === undefined) return [];
    if (!['user', 'project', 'local'].includes(scope)) throw new Error("scope must be 'user', 'project' or 'local'");
    return ['--scope', scope];
  }

  install(plugin: unknown, scope?: PluginScope): Promise<CliTextResult> {
    return this.text(['plugin', 'install', ...this.scopeArgs(scope), this.plugin(plugin)]);
  }
  uninstall(plugin: unknown, scope?: PluginScope): Promise<CliTextResult> {
    return this.text(['plugin', 'uninstall', ...this.scopeArgs(scope), this.plugin(plugin)]);
  }
  enable(plugin: unknown, scope?: PluginScope): Promise<CliTextResult> {
    return this.text(['plugin', 'enable', ...this.scopeArgs(scope), this.plugin(plugin)]);
  }
  disable(plugin: unknown, scope?: PluginScope): Promise<CliTextResult> {
    return this.text(['plugin', 'disable', ...this.scopeArgs(scope), this.plugin(plugin)]);
  }
  details(plugin: unknown): Promise<CliTextResult> {
    return this.text(['plugin', 'details', this.plugin(plugin)]);
  }

  addMarketplace(source: unknown): Promise<CliTextResult> {
    if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
      throw new Error('invalid marketplace source (GitHub owner/repo, URL or path)');
    }
    return this.text(['plugin', 'marketplace', 'add', source]);
  }
  removeMarketplace(name: string): Promise<CliTextResult> {
    if (!NAME_RE.test(name)) throw new Error('invalid marketplace name');
    return this.text(['plugin', 'marketplace', 'remove', name]);
  }
  updateMarketplace(name?: unknown): Promise<CliTextResult> {
    if (name !== undefined && name !== '' && (typeof name !== 'string' || !NAME_RE.test(name))) throw new Error('invalid marketplace name');
    return this.text(['plugin', 'marketplace', 'update', ...(name ? [name as string] : [])]);
  }
}
