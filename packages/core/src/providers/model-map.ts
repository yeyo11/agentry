import type { ModelMapEntry, ModelOption, ProviderId } from '@agentry/shared';

/**
 * The model a run would use on another provider. Pure: the catalog and the mapping come in as
 * values, so the candidates and the settings editor read the same answer.
 *
 * - The target's own model: the run's model is in the target's catalog, or the target is the
 *   provider it came from.
 * - A mapped model: an entry from the run's provider to the target whose model the target's
 *   catalog still lists. An entry whose model left the catalog counts as missing.
 * - `undefined` when there is none: the run waits and says why (decision P4-3, the map starts empty).
 *
 * A catalog that is empty (a provider not yet read) cannot contradict an entry, so it is trusted.
 */
export function mapModel(
  map: readonly ModelMapEntry[],
  from: { provider: ProviderId; id: string; names?: readonly string[] },
  target: ProviderId,
  catalog: readonly ModelOption[],
): string | undefined {
  if (from.provider === target) return from.id;
  // A run knows its model by the id the CLI reported; the map may hold the alias the person picked
  const names = new Set([from.id, ...(from.names ?? [])]);
  if (catalog.some((m) => m.value === from.id && !m.disabled)) return from.id;
  const entry = map.find((e) => e.from.provider === from.provider && names.has(e.from.model) && e.to.provider === target);
  return entry && !entryIsStale(entry, catalog) ? entry.to.model : undefined;
}

/** True when an entry's target model is no longer in its provider's catalog: the editor marks it. */
export function entryIsStale(entry: ModelMapEntry, catalog: readonly ModelOption[]): boolean {
  return catalog.length > 0 && !catalog.some((m) => m.value === entry.to.model && !m.disabled);
}
