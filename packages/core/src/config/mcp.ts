import { join } from 'node:path';
import type { McpHealthStatus, McpScope, McpServerEntry, McpServerHealth } from '@agentry/shared';
import { execCli } from '../cli.ts';
import type { CoreConfig } from '../paths.ts';
import { readJson } from './files.ts';
import type { ConfigScope } from './scope.ts';

// The name is passed as a CLI argument: a leading '-' would be parsed as a flag
const NAME_RE = /^[A-Za-z0-9_][\w.-]{0,63}$/;
const HEALTH_TIMEOUT_MS = 90_000;

type ServerMap = Record<string, Record<string, unknown>>;

export function parseMcpScope(value: unknown, scope: ConfigScope): McpScope {
  if (value === undefined || value === '') return scope.kind === 'user' ? 'user' : 'project';
  if (value !== 'user' && value !== 'project' && value !== 'local') throw new Error("scope must be 'user', 'project' or 'local'");
  if (value !== 'user' && scope.kind !== 'project') throw new Error(`MCP scope '${value}' needs a project`);
  return value;
}

/** `name: target - ✔ Connected` lines printed by `claude mcp list`. */
export function parseMcpHealth(output: string): McpServerHealth[] {
  const result: McpServerHealth[] = [];
  for (const line of output.split('\n')) {
    const nameEnd = line.indexOf(': ');
    const statusStart = line.lastIndexOf(' - ');
    if (nameEnd <= 0 || statusStart <= nameEnd) continue;
    const detail = line.slice(statusStart + 3).trim();
    const lower = detail.toLowerCase();
    const status: McpHealthStatus = lower.includes('needs auth')
      ? 'needs-auth'
      : lower.includes('connected') && !lower.includes('fail')
        ? 'connected'
        : lower.includes('fail') || lower.includes('error')
          ? 'failed'
          : lower.includes('pending')
            ? 'pending'
            : 'unknown';
    result.push({ name: line.slice(0, nameEnd).trim(), status, detail: detail.replace(/^[^\w]+/, '') });
  }
  return result;
}

/**
 * MCP servers across scopes. Reads come straight from the files the CLI owns (fast, no health
 * checks); writes go through `claude mcp`, run from the project directory for project/local.
 *   user -> <globalConfig>.mcpServers        local -> <globalConfig>.projects[path].mcpServers
 *   project -> <project>/.mcp.json
 */
export class McpConfig {
  constructor(private readonly config: CoreConfig) {}

  private async read(scope: ConfigScope, mcpScope: McpScope): Promise<ServerMap> {
    if (mcpScope === 'project') {
      if (scope.kind !== 'project') return {};
      const json = await readJson(join(scope.projectPath, '.mcp.json')).catch(() => ({}) as Record<string, unknown>);
      return (json.mcpServers ?? {}) as ServerMap;
    }
    const global = await readJson(this.config.globalConfigFile).catch(() => ({}) as Record<string, unknown>);
    if (mcpScope === 'user') return (global.mcpServers ?? {}) as ServerMap;
    if (scope.kind !== 'project') return {};
    const projects = (global.projects ?? {}) as Record<string, { mcpServers?: ServerMap }>;
    return projects[scope.projectPath]?.mcpServers ?? {};
  }

  /** User scope lists user servers; project scope lists local + project + the inherited user ones. */
  async list(scope: ConfigScope): Promise<McpServerEntry[]> {
    const scopes: McpScope[] = scope.kind === 'project' ? ['local', 'project', 'user'] : ['user'];
    const entries: McpServerEntry[] = [];
    for (const mcpScope of scopes) {
      for (const [name, serverConfig] of Object.entries(await this.read(scope, mcpScope))) {
        entries.push({ name, scope: mcpScope, config: serverConfig });
      }
    }
    return entries;
  }

  private cwd(scope: ConfigScope): string | undefined {
    return scope.kind === 'project' ? scope.projectPath : undefined;
  }

  async upsert(scope: ConfigScope, mcpScope: McpScope, name: string, serverConfig: unknown): Promise<McpServerEntry> {
    if (!NAME_RE.test(name)) throw new Error('invalid server name (letters, digits, _ . - only; cannot start with - or .)');
    if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
      throw new Error('config must be a JSON object, e.g. {"command":"npx","args":["-y","pkg"]} or {"type":"http","url":"…"}');
    }
    if (name in (await this.read(scope, mcpScope))) await this.remove(scope, mcpScope, name);
    const res = await execCli(this.config, ['mcp', 'add-json', '--scope', mcpScope, name, JSON.stringify(serverConfig)], {
      cwd: this.cwd(scope),
    });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || 'claude mcp add-json failed');
    const saved = (await this.read(scope, mcpScope))[name];
    if (!saved) throw new Error('server was not persisted by the CLI');
    return { name, scope: mcpScope, config: saved };
  }

  async remove(scope: ConfigScope, mcpScope: McpScope, name: string): Promise<void> {
    if (!NAME_RE.test(name)) throw new Error('invalid server name');
    const res = await execCli(this.config, ['mcp', 'remove', '--scope', mcpScope, name], { cwd: this.cwd(scope) });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || 'claude mcp remove failed');
  }

  /** Real connection checks (`claude mcp list`): slow, call on demand only. */
  async health(scope: ConfigScope): Promise<McpServerHealth[]> {
    const res = await execCli(this.config, ['mcp', 'list'], { cwd: this.cwd(scope), timeoutMs: HEALTH_TIMEOUT_MS });
    return parseMcpHealth(res.stdout);
  }
}
