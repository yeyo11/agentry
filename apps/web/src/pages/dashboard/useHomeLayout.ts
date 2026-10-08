import { useQueryClient } from '@tanstack/react-query';
import type { StoredDashboardLayout } from '@agentry/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useDashboardLayout } from '../../api';
import { useToast } from '@agentry/ui/components/Toast';
import type { DashboardLayout, DashboardScope } from './layout';
import { resolveLayout } from './registry';

export interface HomeLayout {
  /** What the page draws: the stored layout reduced to what this version can draw, or the default */
  layout: DashboardLayout;
  /** Whether one is stored, which is what Restablecer would remove */
  stored: boolean;
  /** The stored layout has not been read yet: drawing the default now would flash and then jump */
  loading: boolean;
  /** Saves at once and shows it at once; a refusal puts the previous layout back and says so */
  save: (next: DashboardLayout) => Promise<void>;
  /** Back to the default, with a toast that brings the stored layout back */
  reset: () => Promise<void>;
}

/**
 * A Home's layout, per project (`key` is its id) or for All projects (`all`). Read from the layout
 * routes and kept current by `dashboard.layout` (lib/events.ts); when nothing is stored, the stored
 * layout does not validate or the read fails, the default is drawn, never an empty page.
 */
export function useHomeLayout(key: string, scope: DashboardScope): HomeLayout {
  const { t } = useTranslation('home');
  const client = useQueryClient();
  const toast = useToast();
  const query = useDashboardLayout(key);
  const storedLayout = query.data?.layout ?? null;
  const layout = useMemo(() => resolveLayout(storedLayout, scope), [storedLayout, scope]);

  const write = async (next: DashboardLayout | null) => {
    const at = keys.dashboardLayout(key);
    const before = client.getQueryData<StoredDashboardLayout>(at);
    client.setQueryData<StoredDashboardLayout>(at, { project: key, layout: next });
    try {
      client.setQueryData<StoredDashboardLayout>(at, next ? await api.saveDashboardLayout(key, next) : await api.resetDashboardLayout(key));
    } catch (error) {
      client.setQueryData(at, before);
      toast.error(t('edit.saveFailed'), error);
    }
  };

  return {
    layout,
    stored: storedLayout !== null,
    loading: query.isPending,
    save: (next) => write(next),
    reset: async () => {
      const previous = storedLayout;
      await write(null);
      toast.show({
        tone: 'info',
        title: t('edit.resetDone'),
        key: 'home-layout-reset',
        action: previous ? { label: t('edit.undo'), onClick: () => void write(previous) } : undefined,
      });
    },
  };
}
