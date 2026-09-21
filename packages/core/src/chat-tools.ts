import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatStartOptions, ChatToolConfig, McpSelection, ToolPreset, ToolPresetsConfig, ToolPresetsOverview } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { McpConfig } from './config/mcp.ts';
import { projectScope } from './config/scope.ts';
import type { CoreConfig } from './paths.ts';

const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TOOL_RULES = 200;
/** `PUT /config/tool-presets/default` sets the default, so no preset can be written under that id */
const RESERVED_IDS = new Set(['default']);

/**
 * What a fresh install offers. They are ordinary presets once stored: edit or delete any of them.
 * A tool rule is what `--allowedTools` takes, so `Bash(git log:*)` allows that one command.
 */
export const DEFAULT_TOOL_PRESETS: readonly ToolPreset[] = [
  {
    id: 'read-only',
    name: 'Read only',
    description: 'Look around and read git history; nothing can be written or changed',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    builtIn: true,
  },
  {
    id: 'no-network',
    name: 'No network',
    description: 'Everything local, without web tools or curl/wget. A script can still open a socket',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash'],
    disallowedTools: ['WebFetch', 'WebSearch', 'Bash(curl:*)', 'Bash(wget:*)'],
    builtIn: true,
  },
  {
    id: 'everything',
    name: 'Everything',
    description: 'Every built-in tool, web included, without asking',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'],
    disallowedTools: [],
    builtIn: true,
  },
];

function rules(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${field} must be a list of strings`);
  const list = [...new Set(value.map((v: string) => v.trim()).filter(Boolean))];
  if (list.length > MAX_TOOL_RULES) throw new Error(`${field} has more than ${String(MAX_TOOL_RULES)} entries`);
  // The list is joined with commas onto one flag: a comma inside a rule would split it in two
  if (list.some((rule) => rule.includes(','))) throw new Error(`${field}: a tool rule cannot contain a comma`);
  return list;
}

/** Validates a preset a person wrote; `builtIn` is Agentry's to say, never the caller's. */
export function parsePreset(id: string, input: unknown, builtIn = false): ToolPreset {
  if (!PRESET_ID_RE.test(id)) throw new Error('invalid preset id (lowercase letters, digits and - only, up to 40 characters)');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('preset must be a JSON object');
  const body = input as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('name is required');
  if (name.length > 80) throw new Error('name is longer than 80 characters');
  if (body.description !== undefined && typeof body.description !== 'string') throw new Error('description must be a string');
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '';
  return {
    id,
    name,
    ...(description ? { description } : {}),
    allowedTools: rules(body.allowedTools, 'allowedTools'),
    disallowedTools: rules(body.disallowedTools, 'disallowedTools'),
    ...(builtIn ? { builtIn: true } : {}),
  };
}

/** What `tool-presets.json` holds, read once per call so an edit by hand is seen at once. */
interface PresetsDocument {
  presets: ToolPreset[];
  defaultPresetId: string | null;
}

/**
 * The stored presets, one JSON document in the data directory. The file does not exist until the
 * first edit: until then the list is the shipped one, so an install that never opens the editor
 * follows the defaults of whatever version it runs.
 */
export class ToolPresetStore {
  private readonly file: string;

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'tool-presets.json');
    mkdirSync(config.dataDir, { recursive: true });
  }

  list(): ToolPreset[] {
    return this.read().presets;
  }

  get(id: string): ToolPreset | undefined {
    return this.list().find((p) => p.id === id);
  }

  overview(): ToolPresetsOverview {
    const { presets, defaultPresetId } = this.read();
    return { defaultPresetId, presets };
  }

  /** The preset a new chat that picks no tools takes, when it still exists. */
  defaultPreset(): ToolPreset | null {
    const { presets, defaultPresetId } = this.read();
    return presets.find((p) => p.id === defaultPresetId) ?? null;
  }

  async setDefault(input: unknown): Promise<ToolPresetsConfig> {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
    const id = body?.defaultPresetId;
    if (id !== null && typeof id !== 'string') throw new Error('defaultPresetId must be a preset id or null');
    const doc = this.read();
    if (id !== null && !doc.presets.some((p) => p.id === id)) throw new Error(`tool preset '${id}' not found`);
    await this.save({ ...doc, defaultPresetId: id });
    return { defaultPresetId: id };
  }

  async upsert(id: string, input: unknown): Promise<ToolPreset> {
    if (RESERVED_IDS.has(id)) throw new Error(`'${id}' is reserved and cannot be a preset id`);
    const preset = parsePreset(id, input, DEFAULT_TOOL_PRESETS.some((p) => p.id === id));
    const doc = this.read();
    const at = doc.presets.findIndex((p) => p.id === id);
    if (at >= 0) doc.presets[at] = preset;
    else doc.presets.push(preset);
    await this.save(doc);
    return preset;
  }

  async remove(id: string): Promise<void> {
    const doc = this.read();
    if (!doc.presets.some((p) => p.id === id)) throw new Error('tool preset not found');
    // A default that names nothing would be a setting nobody can see the effect of
    await this.save({ presets: doc.presets.filter((p) => p.id !== id), defaultPresetId: doc.defaultPresetId === id ? null : doc.defaultPresetId });
  }

  /**
   * Puts the shipped presets back as they ship, edited or deleted, where they were in the list or at
   * its end. Presets a person made are not touched, and neither is the default.
   */
  async restore(): Promise<ToolPresetsOverview> {
    const doc = this.read();
    const presets = [...doc.presets];
    for (const shipped of DEFAULT_TOOL_PRESETS) {
      const copy = { ...shipped, allowedTools: [...shipped.allowedTools], disallowedTools: [...(shipped.disallowedTools ?? [])] };
      const at = presets.findIndex((p) => p.id === shipped.id);
      if (at >= 0) presets[at] = copy;
      else presets.push(copy);
    }
    await this.save({ ...doc, presets });
    return { defaultPresetId: doc.defaultPresetId, presets };
  }

  private read(): PresetsDocument {
    if (!existsSync(this.file)) return { presets: DEFAULT_TOOL_PRESETS.map((p) => ({ ...p })), defaultPresetId: null };
    let doc: { presets?: unknown; defaultPresetId?: unknown };
    try {
      doc = JSON.parse(readFileSync(this.file, 'utf8')) as { presets?: unknown; defaultPresetId?: unknown };
    } catch {
      // A document that does not parse would otherwise be overwritten by the next edit
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
    const defaultPresetId = typeof doc.defaultPresetId === 'string' ? doc.defaultPresetId : null;
    if (!Array.isArray(doc.presets)) return { presets: [], defaultPresetId };
    const shipped = new Set(DEFAULT_TOOL_PRESETS.map((p) => p.id));
    const presets: ToolPreset[] = [];
    for (const raw of doc.presets as unknown[]) {
      const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
      if (typeof id !== 'string') continue;
      try {
        presets.push(parsePreset(id, raw, shipped.has(id)));
      } catch {
        // One bad entry is not a reason to lose the others
      }
    }
    return { presets, defaultPresetId };
  }

  private save(doc: PresetsDocument): Promise<void> {
    return writeAtomic(this.file, `${JSON.stringify({ defaultPresetId: doc.defaultPresetId, presets: doc.presets }, null, 2)}\n`);
  }
}

/** What a request that picked tools or servers turns into for the chat it starts. */
export interface ToolChoice {
  allowedTools?: string[];
  disallowedTools?: string[];
  /** `null` takes a chat back to what the CLI loads on its own */
  mcp?: McpSelection | null;
  toolConfig: ChatToolConfig | null;
}

/**
 * Turns "this preset, these servers" into what the CLI is given: the tool lists, and a config file
 * holding only the chosen servers, passed with `--strict-mcp-config` so nothing else loads.
 */
export class ChatTools {
  constructor(
    private readonly config: CoreConfig,
    private readonly mcp: McpConfig,
    readonly presets: ToolPresetStore,
  ) {}

  /**
   * Null when the request picks nothing and there is nothing to refresh, which leaves the chat as it
   * is: a chat that never chose behaves as it always did. `current` is what the chat already runs
   * with (for a fork, what its source runs with), kept for whichever half the request does not
   * touch. `fresh` says the chat has no options of its own yet, as a fork has not, so what it keeps
   * from `current` has to be handed over in full.
   */
  async resolve(request: ChatStartOptions, cwd: string, current: ChatToolConfig | null, opts: { fresh?: boolean } = {}): Promise<ToolChoice | null> {
    const toolsPicked = request.toolPreset !== undefined || request.allowedTools !== undefined || request.disallowedTools !== undefined;
    const mcpPicked = request.mcp !== undefined;
    const carried = opts.fresh === true && current !== null;
    const refreshed = !mcpPicked && Boolean(current?.mcp);
    if (!toolsPicked && !mcpPicked && !carried && !refreshed) return null;

    let preset = current?.preset ?? null;
    let allowedTools = current?.allowedTools ?? [];
    let disallowedTools = current?.disallowedTools ?? [];
    if (toolsPicked) {
      const chosen = typeof request.toolPreset === 'string' ? this.presets.get(request.toolPreset) : null;
      if (typeof request.toolPreset === 'string' && !chosen) throw new Error(`tool preset '${request.toolPreset}' not found`);
      preset = chosen ?? null;
      // What was said outright wins over the preset it came with
      allowedTools = request.allowedTools !== undefined ? rules(request.allowedTools, 'allowedTools') : (chosen?.allowedTools ?? []);
      disallowedTools = request.disallowedTools !== undefined ? rules(request.disallowedTools, 'disallowedTools') : (chosen?.disallowedTools ?? []);
    }

    let mcp = current?.mcp ?? null;
    if (mcpPicked) mcp = request.mcp ? await this.selectServers(request.mcp, cwd) : null;
    else if (current?.mcp) mcp = await this.refreshServers(current.mcp, cwd);

    return {
      ...(toolsPicked || carried ? { allowedTools, disallowedTools } : {}),
      ...(mcpPicked || carried || refreshed ? { mcp } : {}),
      toolConfig: { preset, allowedTools, disallowedTools, mcp },
    };
  }

  /**
   * The same servers, as they are defined now. The file a chat was started with holds a copy of each
   * definition, so without this a server edited since (a new URL, a rotated token) would keep
   * starting with the old one. A server removed since is left out: it cannot be loaded as configured,
   * and the copy of it may hold a secret its owner meant to retire.
   */
  private async refreshServers(selection: McpSelection, cwd: string): Promise<McpSelection> {
    const known = new Set((await this.mcp.list(projectScope(cwd))).map((entry) => entry.name));
    return this.selectServers({ servers: selection.servers.filter((name) => known.has(name)) }, cwd);
  }

  /** Reads the servers as the CLI would see them from `cwd` (local, then project, then user) and keeps the chosen ones. */
  private async selectServers(selection: McpSelection, cwd: string): Promise<McpSelection> {
    if (!Array.isArray(selection.servers) || selection.servers.some((s) => typeof s !== 'string')) {
      throw new Error('mcp.servers must be a list of server names');
    }
    const names = [...new Set(selection.servers)];
    const known = new Map<string, Record<string, unknown>>();
    // list() puts the scope that wins first, and the CLI resolves a repeated name the same way
    for (const entry of await this.mcp.list(projectScope(cwd))) if (!known.has(entry.name)) known.set(entry.name, entry.config as Record<string, unknown>);
    const mcpServers: Record<string, Record<string, unknown>> = {};
    for (const name of names) {
      const server = known.get(name);
      if (!server) throw new Error(`MCP server '${name}' is not configured (see GET /config/mcp)`);
      mcpServers[name] = server;
    }
    return { servers: names, config: await this.writeConfig(mcpServers) };
  }

  /**
   * The file is named by what it holds, so choosing the same servers twice reuses one file. It can
   * carry the servers' `env` and `headers`, which are secrets: only the owner may read it.
   */
  private async writeConfig(mcpServers: Record<string, Record<string, unknown>>): Promise<string> {
    const body = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
    const dir = join(this.config.dataDir, 'mcp');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`);
    await writeFile(file, body, { mode: 0o600 });
    await chmod(file, 0o600);
    return file;
  }
}
