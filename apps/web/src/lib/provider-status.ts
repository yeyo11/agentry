import type { ProviderId, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { api, keys } from '../api';
import { useProviders } from './providers';
import { isUsable } from './provider-state';

/** Where the providers are managed; the status bar and Home lead here. */
export const PROVIDERS_SETTINGS_PATH = '/settings?tab=providers';

/**
 * The providers that are on, in the order the settings list them. Without settings (not read yet,
 * or the read failed) every detected provider counts: a status is still better than silence.
 */
export function enabledProviders(statuses: ProviderStatus[], settings: ProvidersSettings | undefined): ProviderStatus[] {
  if (!settings) return statuses;
  const rank = (id: string) => {
    const at = settings.order.indexOf(id);
    return at === -1 ? settings.order.length : at;
  };
  return statuses.filter((s) => settings.providers[s.id]?.enabled !== false).sort((a, b) => rank(a.id) - rank(b.id));
}

/** What Home says about the providers: nothing to say, or what a person has to do first. */
export interface ProviderSetup {
  /**
   * `none`: no enabled provider is installed. `blocked`: some are, none can start work.
   * `attention`: one can, others need a person. `ok`: nothing to say.
   */
  kind: 'none' | 'blocked' | 'attention' | 'ok';
  /** The enabled providers that are not usable and have something to fix, in list order */
  problems: ProviderStatus[];
  /** The enabled providers that can start work */
  usable: ProviderStatus[];
}

export function providerSetup(enabled: ProviderStatus[]): ProviderSetup {
  const usable = enabled.filter(isUsable);
  // A provider that is simply not there is not a problem while another one works
  const problems = enabled.filter((s) => !isUsable(s) && s.state !== 'not-installed');
  if (usable.length > 0) return { kind: problems.length > 0 ? 'attention' : 'ok', problems, usable };
  return { kind: problems.length === 0 ? 'none' : 'blocked', problems, usable };
}

/** A status's reason in plain words, for a place that cannot call the `useProviderReason` hook (a loop). */
export function reasonText(t: TFunction<'providers'>, status: ProviderStatus): string {
  if (status.reason === null) return t(`state.${status.state}`);
  return t(`reason.${status.reason}`, {
    version: status.version ? `v${status.version}` : '',
    range: status.compatibleRange,
    label: status.label,
    home: status.configHome ?? '',
  });
}

/** The enabled providers' statuses, and whether the first reading is still on its way. */
export function useEnabledProviders() {
  const providers = useProviders();
  const settings = useQuery({ queryKey: keys.providerSettings, queryFn: () => api.providerSettings() });
  const statuses = providers.data ? enabledProviders(providers.data, settings.data) : undefined;
  return { statuses, loading: providers.isPending };
}

/**
 * The name of the agent a chat runs on, from the provider's own label. Before the list is read the
 * id stands in, so a sentence never waits on it.
 */
export function useProviderLabel(): (provider: ProviderId) => string {
  const statuses = useProviders().data;
  return useCallback((provider) => statuses?.find((s) => s.id === provider)?.label ?? provider, [statuses]);
}

/**
 * The providers a new chat can start on: enabled and usable, in the person's order with the default
 * first. A provider detected as usable has a session driver, so that is the whole test.
 */
export function useNewChatProviders(): ProviderStatus[] {
  const { statuses } = useEnabledProviders();
  const defaultProvider = useQuery({ queryKey: keys.providerSettings, queryFn: () => api.providerSettings() }).data?.defaultProvider;
  return useMemo(() => {
    const usable = (statuses ?? []).filter(isUsable);
    return defaultProvider ? [...usable.filter((s) => s.id === defaultProvider), ...usable.filter((s) => s.id !== defaultProvider)] : usable;
  }, [statuses, defaultProvider]);
}

/** What the provider offers for the model picker; nothing is read for an empty id. */
export function useProviderModels(provider: ProviderId) {
  return useQuery({ queryKey: keys.providerModels(provider), queryFn: () => api.providerModels(provider), enabled: provider !== '', retry: false });
}
