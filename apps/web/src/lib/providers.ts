import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderStatus } from '@agentry/shared';
import { api, keys } from '../api';

/**
 * Every provider's status, in the order of the settings. Nothing here polls: the event feed reads
 * the query again when `providers.changed` arrives (`lib/events.ts`), so an install or a sign-in
 * made in a terminal shows up on its own.
 */
export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: () => api.providers() });
}

/**
 * Detect again now, skipping the cache. The answer replaces the list at once; the event that
 * follows a real change then only confirms it.
 */
export function useRefreshProviders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshProviders(),
    onSuccess: (fresh: ProviderStatus[]) => queryClient.setQueryData(keys.providers, fresh),
  });
}
