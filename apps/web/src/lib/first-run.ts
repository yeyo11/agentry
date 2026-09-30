import type { AppSettings, ProviderReadinessState, ProviderStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, keys } from '../api';
import { isUsable } from './provider-state';
import { useProviders } from './providers';

/** The order the step lists its groups in: what works, then what a person can fix, then what is missing */
export const FIRST_RUN_GROUPS = ['ready', 'signed-out', 'attention', 'used-before', 'not-installed'] as const;
export type FirstRunGroup = (typeof FIRST_RUN_GROUPS)[number];

const GROUP_OF: Record<ProviderReadinessState, FirstRunGroup> = {
  ready: 'ready',
  degraded: 'ready',
  'signed-out': 'signed-out',
  incompatible: 'attention',
  unknown: 'attention',
  'used-before': 'used-before',
  'not-installed': 'not-installed',
};

/** The statuses by group, in the order of the settings inside each; a group with none is left out. */
export function groupProviders(statuses: ProviderStatus[]): { group: FirstRunGroup; providers: ProviderStatus[] }[] {
  return FIRST_RUN_GROUPS.map((group) => ({ group, providers: statuses.filter((status) => GROUP_OF[status.state] === group) })).filter(
    (entry) => entry.providers.length > 0,
  );
}

/** The provider "Continue" names: the first one that is ready, or else the first that works with a warning. */
export function firstReady(statuses: ProviderStatus[]): ProviderStatus | null {
  return statuses.find((status) => status.state === 'ready') ?? statuses.find(isUsable) ?? null;
}

/** Nothing at all was found: every provider is missing, so the step has a page of its own for it. */
export const nothingFound = (statuses: ProviderStatus[]): boolean => statuses.length > 0 && statuses.every((status) => status.state === 'not-installed');

/**
 * The step is for the first start, and for every start where nothing could run a chat: a wrapper
 * with no ready provider cannot do anything else, so its answer is worth putting first. Once seen,
 * it never stands in front of Settings, which is where a provider gets fixed (a binary override, a
 * provider turned on); Home and the status bar still say nothing is ready.
 */
export const shouldShowFirstRun = (seen: boolean, statuses: ProviderStatus[], path = '/'): boolean =>
  !seen || (!statuses.some(isUsable) && !path.startsWith('/settings'));

export type FirstRun = { state: 'pending' | 'hidden' } | { state: 'shown'; statuses: ProviderStatus[]; finish: () => void };

/**
 * Whether the first-run step stands in for the app. A failed read of either query hides it: the
 * step must never be what keeps a person out of an app that would have worked. `finish` dismisses
 * it for this page load and records it in the app settings, unless the environment owns that
 * setting (then it is only remembered until the page reloads).
 */
export function useFirstRun(): FirstRun {
  const settings = useQuery({ queryKey: keys.appSettings, queryFn: api.appSettings });
  const providers = useProviders();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const { pathname } = useLocation();
  const save = useMutation({
    mutationFn: () => api.updateAppSettings({ providersStepSeen: true }),
    onSuccess: (next: AppSettings) => queryClient.setQueryData(keys.appSettings, next),
  });

  if (dismissed || settings.isError || providers.isError) return { state: 'hidden' };
  if (!settings.data || !providers.data) return { state: 'pending' };
  const seen = settings.data.providersStepSeen;
  if (!shouldShowFirstRun(seen, providers.data, pathname)) return { state: 'hidden' };
  return {
    state: 'shown',
    statuses: providers.data,
    finish: () => {
      setDismissed(true);
      if (!seen && settings.data.sources.providersStepSeen !== 'env') save.mutate();
    },
  };
}
