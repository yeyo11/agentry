import { useMemo } from 'react';
import { useAccounts, useConnectors, useSchedules } from '../../api';
import { accountExhausted } from '../../pages/accounts/usage';
import { moreNotes, type MoreNote } from '../../lib/shell-live';
import { useUsageNow } from '../../lib/usage-now';

/**
 * The figures beside the More sheet's sections. It is called from inside the open sheet, so the
 * lists only the sheet needs (accounts, schedules, connectors) are read while it is open, through
 * the query keys their pages use: a page opened from here finds its data already there, and the
 * sheet opened from that page asks for nothing. Projects and today's cost come from the overview
 * and the usage query the shell already keeps.
 */
export function useMoreNotes(): Record<string, MoreNote> {
  const now = useUsageNow();
  const overview = now.overview.data;
  // Without claude-swap there is no account list to read, only its absence
  const swap = overview?.accounts?.installed === true;
  const accounts = useAccounts(swap);
  const schedules = useSchedules();
  const connectors = useConnectors();

  const accountList = accounts.data?.accounts;
  const connectorsData = connectors.data;
  const scheduleCount = schedules.data?.length;
  return useMemo(
    () =>
      moreNotes({
        projects: overview?.counts.projects,
        accounts: swap
          ? accountList
            ? { total: accountList.length, exhausted: accountList.filter(accountExhausted).length }
            : overview?.accounts
              ? { total: overview.accounts.total }
              : undefined
          : undefined,
        schedules: scheduleCount,
        todayCost: now.todayCost,
        // A CLI that could not be asked has an empty list, which is not "no connectors"
        connectors:
          connectorsData && !connectorsData.error
            ? { total: connectorsData.connectors.length, pending: connectorsData.connectors.filter((c) => c.status === 'needs-auth').length }
            : undefined,
      }),
    [overview, swap, accountList, scheduleCount, now.todayCost, connectorsData],
  );
}
