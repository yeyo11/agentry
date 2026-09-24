/**
 * What `--model` may be given, as the CLI itself knows it.
 *
 * Claude Code caches the options it offers under `/model` in its own state file (`.claude.json`,
 * key `additionalModelOptionsCache`), already filtered by what the logged-in account's subscription
 * allows and by what this version of the CLI can run. Reading that file — the CLI writes it — is
 * how the wrapper offers the same list: a list of its own went stale with every release and never
 * knew what a given account could actually run. The aliases the CLI always takes come first, and
 * whatever the account adds follows.
 */
import { readFileSync, statSync } from 'node:fs';
import { MODEL_ALIASES, type ModelOption } from '@agentry/shared';

/** The aliases as options, which is the answer whenever the file says nothing. */
const ALIASES: ModelOption[] = MODEL_ALIASES.map((value) => ({ value }));

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

export function modelOptions(file: string): ModelOption[] {
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
