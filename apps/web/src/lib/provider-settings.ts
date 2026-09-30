import type { ProviderId, ProviderSettingsEntry, ProviderStatus, ProvidersSettings } from '@agentry/shared';

// Pure edits of `providers.json`: the page builds the next document with these and sends it whole,
// so a test can read every rule (what a missing entry means, what an order does with strangers)
// without a page.

const DEFAULT_ENTRY: ProviderSettingsEntry = {
  enabled: true,
  binaryPath: null,
};

/** What is chosen for one provider; a provider nobody has touched is on and searched for. */
export const entryOf = (settings: ProvidersSettings, id: ProviderId): ProviderSettingsEntry => settings.providers[id] ?? DEFAULT_ENTRY;

/**
 * The ids in the order the list shows: the settings' order first, then any provider the settings do
 * not mention yet (a new manifest), and never an id the detector does not know.
 */
export function orderedIds(statuses: readonly ProviderStatus[], settings: ProvidersSettings): ProviderId[] {
  const known = new Set(statuses.map((s) => s.id));
  const ids = settings.order.filter((id, at) => known.has(id) && settings.order.indexOf(id) === at);
  for (const { id } of statuses) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** The next order with the item at `from` taken out and put at `to`. */
export function moveTo(order: readonly ProviderId[], from: number, to: number): ProviderId[] {
  const next = [...order];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}

/** The next order with `id` moved `delta` places; unchanged when it would leave the list. */
export function moveBy(order: readonly ProviderId[], id: ProviderId, delta: number): ProviderId[] {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  return moveTo(order, from, to);
}

/** The document with one provider's entry changed and the order made explicit. */
export function withEntry(
  settings: ProvidersSettings,
  order: readonly ProviderId[],
  id: ProviderId,
  patch: Partial<ProviderSettingsEntry>,
): ProvidersSettings {
  return {
    ...settings,
    order: [...order],
    providers: {
      ...settings.providers,
      [id]: { ...entryOf(settings, id), ...patch },
    },
  };
}

/** The document with a new order and default; a null default is "Automatic". */
export function withOrder(
  settings: ProvidersSettings,
  order: readonly ProviderId[],
  defaultProvider: ProviderId | null,
): ProvidersSettings {
  return { ...settings, order: [...order], defaultProvider };
}

/**
 * The provider a new chat starts with: the chosen one, or with "Automatic" the first that is on and
 * ready. Null when nothing qualifies.
 */
export function effectiveDefault(statuses: readonly ProviderStatus[], settings: ProvidersSettings): ProviderId | null {
  if (settings.defaultProvider && statuses.some((s) => s.id === settings.defaultProvider)) return settings.defaultProvider;
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return orderedIds(statuses, settings).find((id) => entryOf(settings, id).enabled && byId.get(id)?.state === 'ready') ?? null;
}

/** The newest detection among the statuses, as an ISO timestamp; null before the first one. */
export function latestCheck(statuses: readonly ProviderStatus[]): string | null {
  return statuses.reduce<string | null>((latest, s) => (latest === null || s.checkedAt > latest ? s.checkedAt : latest), null);
}
