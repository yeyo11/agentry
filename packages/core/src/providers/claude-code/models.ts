/**
 * What `--model` may be given, as the CLI itself knows it.
 *
 * Claude Code caches the options it offers under `/model` in its own state file (`.claude.json`,
 * key `additionalModelOptionsCache`), already filtered by what the logged-in account's subscription
 * allows and by what this version of the CLI can run. Reading that file — the CLI writes it — is
 * how the wrapper offers the same list: a list of its own went stale with every release and never
 * knew what a given account could actually run. The aliases the CLI always takes come first, and
 * whatever the account adds follows.
 *
 * The aliases carry no label in that file, so the name of the model an alias stands for ("Sonnet 5"
 * for `sonnet`) is learned from the CLI too: each chat's `system/init` event reports the model id
 * its process runs (`claude-sonnet-5`), and the id a chat started with an alias reported is kept
 * per alias ({@link ModelAliasIds}). The name is derived from that id by rule
 * ({@link modelDisplayName}); an alias no chat has run on yet stands alone.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelOption, ModelTier } from '@agentry/shared';
import { writeAtomic } from '../../config/files.ts';

/**
 * The aliases the CLI always takes, each the latest model of its line (`claude --help`). What an
 * account may run beyond them depends on its subscription, and the CLI says so itself.
 */
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/** How capable each alias is among Claude's models; `fable` has no rank. */
const ALIAS_TIERS: Readonly<Record<string, ModelTier>> = { haiku: 'fast', sonnet: 'balanced', opus: 'strong' };

/** The aliases as options, which is the answer whenever the file says nothing. */
const ALIASES: ModelOption[] = MODEL_ALIASES.map((value) => ({ value, ...(ALIAS_TIERS[value] ? { tier: ALIAS_TIERS[value] } : {}) }));

/** A model name is a short token: anything else in that file is not one. */
const NAME = /^[\w.[\]:-]{1,120}$/;

/** One line of prose, cut: these are shown as a hint under the name. */
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, 200) : undefined;
};

function parse(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ModelOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { value, label, description, disabled } = item as Record<string, unknown>;
    if (typeof value !== 'string' || !NAME.test(value)) continue;
    options.push({
      value,
      ...(text(label) ? { label: text(label) } : {}),
      ...(text(description) ? { description: text(description) } : {}),
      ...(disabled === true ? { disabled: true } : {}),
    });
  }
  return options;
}

/** Read once per write of the file: the overview asks for this on every poll. */
let cache: { file: string; at: number; size: number; options: ModelOption[] } | null = null;

/**
 * The options, the aliases named after the model each last ran as (`seen`, alias to model id), when
 * a chat has run on it and its id reads as a name.
 */
export function modelOptions(file: string, seen: Readonly<Record<string, string>> = {}): ModelOption[] {
  const options = cliModelOptions(file);
  if (!Object.keys(seen).length) return options;
  return options.map((option) => {
    if (!(MODEL_ALIASES as readonly string[]).includes(option.value)) return option;
    const id = seen[option.value];
    if (!id) return option;
    const label = option.label ? null : modelDisplayName(id);
    return { ...option, ids: [id], ...(label ? { label } : {}) };
  });
}

function cliModelOptions(file: string): ModelOption[] {
  let stamp: { at: number; size: number };
  try {
    const stat = statSync(file);
    stamp = { at: stat.mtimeMs, size: stat.size };
  } catch {
    // No file (a CLI that has never run, or a config dir of its own): the aliases stand alone
    return ALIASES;
  }
  if (cache && cache.file === file && cache.at === stamp.at && cache.size === stamp.size) return cache.options;
  let extra: ModelOption[] = [];
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    extra = parse(state.additionalModelOptionsCache);
  } catch {
    // Half-written or not JSON at all: the file is the CLI's, and it rewrites it often
    extra = [];
  }
  const seen = new Set(ALIASES.map((option) => option.value));
  const options = [...ALIASES];
  for (const option of extra) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    options.push(option);
  }
  cache = { file, ...stamp, options };
  return options;
}

/** Forgets what was read, for a test that writes the file twice within a clock tick. */
export function forgetModelOptions(): void {
  cache = null;
}

/**
 * A model id as people say it: `claude-sonnet-5` is "Sonnet 5", `claude-opus-5-5` "Opus 5.5",
 * `claude-haiku-4-5-20251001` "Haiku 4.5" and `claude-fable-5-1[1m]` "Fable 5.1 (1M)". The rule is
 * the naming scheme of the ids themselves (`claude-`, the family, the version's digits, an optional
 * release date, an optional `[…]` variant), so it needs no list of Agentry's own that a release
 * would make stale. An older id that puts the version first (`claude-3-5-sonnet-20241022`) reads
 * the same way. Null for anything that does not follow the scheme, which is then left unnamed.
 */
export function modelDisplayName(id: string): string | null {
  const match = /^claude-([a-z0-9-]+?)(?:-(\d{8}))?(?:\[([a-z0-9]+)\])?$/i.exec(id.trim());
  if (!match?.[1]) return null;
  const parts = match[1].split('-');
  const words = parts.filter((part) => /^[a-z]+$/i.test(part));
  const digits = parts.filter((part) => /^\d{1,3}$/.test(part));
  if (!words.length || !digits.length || words.length + digits.length !== parts.length) return null;
  const family = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  const variant = match[3] ? ` (${match[3].toUpperCase()})` : '';
  return `${family} ${digits.join('.')}${variant}`;
}

/**
 * The model id each alias last ran as, as the CLI reported it in a chat's `system/init` event. A
 * small document of its own in the data dir (`model-aliases.json`), rewritten only when an alias
 * turns out to stand for another model, which happens once per model release.
 */
export class ModelAliasIds {
  readonly file: string;
  private ids: Record<string, string> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'model-aliases.json');
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      for (const [alias, id] of Object.entries(raw)) if (isPair(alias, id)) this.ids[alias] = id;
    } catch {
      // A broken file only costs the names until the next chat on each alias reports its model again
    }
  }

  /** Alias to model id, for every alias a chat has run on */
  get(): Readonly<Record<string, string>> {
    return this.ids;
  }

  /**
   * What a chat's `system/init` said: the `--model` it was started with and the model the CLI runs.
   * Only an alias is kept, and only an id that is not the alias itself. True when it changed.
   */
  record(requested: string | null | undefined, reported: unknown): boolean {
    const alias = requested?.trim();
    if (!alias || !isPair(alias, reported) || this.ids[alias] === reported) return false;
    this.ids = { ...this.ids, [alias]: reported };
    const content = `${JSON.stringify(this.ids, null, 2)}\n`;
    // In order, so an older write never lands after a newer one
    this.writing = this.writing.then(() => writeAtomic(this.file, content)).catch(() => {
      // the name is kept in memory; the file catches up on the next change
    });
    return true;
  }

  /** Resolves once what was recorded is on disk, for a test that reads the file */
  settled(): Promise<void> {
    return this.writing;
  }
}

function isPair(alias: string, id: unknown): id is string {
  return (MODEL_ALIASES as readonly string[]).includes(alias) && typeof id === 'string' && NAME.test(id) && id !== alias;
}
