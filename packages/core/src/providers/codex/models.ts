import type { ModelOption } from '@agentry/shared';
import type { ModelEntry } from './protocol/types.ts';

/** What the picker offers before a handshake has listed the account's models: Codex's own choice. */
export const DEFAULT_MODELS: ModelOption[] = [{ value: '', label: 'Codex default', description: 'The model Codex picks for the account' }];

/** `model/list` as options: the default first, hidden models left out. Codex ranks none of them, so none has a tier. */
export function codexModelOptions(entries: readonly ModelEntry[]): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const entry of entries) {
    if (entry.hidden || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    options.push({
      value: entry.id,
      ...(entry.displayName ? { label: entry.displayName } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  const first = entries.find((entry) => entry.isDefault && !entry.hidden)?.id;
  options.sort((a, b) => Number(b.value === first) - Number(a.value === first));
  return options.length > 0 ? options : DEFAULT_MODELS;
}
