import type { FlowRun, FlowRunRef } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { useToast } from '@agentry/ui/components/Toast';
import { useRoleName } from '../../team/RoleAvatar';
import { failureReason, rawError, RUN_STATUS_BADGE, runStatus, runStep } from './runs';

type RunNaming = Pick<FlowRun, 'role' | 'stage' | 'column'> & { step?: FlowRun['step'] };

/** "QA verifies AGN-26": a flow run named by its role and what that role does in the run's column. */
export function useRunTitle(): (run: RunNaming, key: string) => string {
  const { t } = useTranslation('workItem');
  const roleName = useRoleName();
  return useCallback((run: RunNaming, key: string) => t(`run.title.${runStep(run)}`, { role: roleName(run.role), key }), [t, roleName]);
}

/** How a run stands, in the glossary's word ("pasó", "fallida"), with a mark so the colour is never alone. */
export function RunStatusBadge({ run }: { run: Pick<FlowRunRef, 'state' | 'outcome'> }) {
  const { t } = useTranslation('workItem');
  const status = runStatus(run);
  const Mark = status === 'passed' ? Check : status === 'failed' ? X : null;
  return (
    <span className={`badge run-status ${RUN_STATUS_BADGE[status]}`.trim()}>
      {Mark && <Mark size={11} strokeWidth={2.25} aria-hidden />}
      {t(`run.status.${status}`)}
    </span>
  );
}

/** Why a failed run failed, in the person's words from its cause; null for a run that did not fail. */
export function useFailureReason(): (run: Pick<FlowRun, 'state' | 'outcome' | 'cause' | 'restarts' | 'stage' | 'column'> & { step?: FlowRun['step'] }) => string | null {
  const { t } = useTranslation('workItem');
  return useCallback(
    (run) => {
      const reason = failureReason(run);
      if (!reason) return null;
      const { count, step } = reason.values;
      // `run.cause.restarts` is a plural (`_one`, `_other`), which the typed keys do not list bare
      const say = t as unknown as (key: string, values: Record<string, string | number>) => string;
      return say(reason.key, { count, doing: t(`run.doing.${step}`) });
    },
    [t],
  );
}

/** The raw text the core or the CLI gave, in mono under the reason: messages from the API are not translated. */
export function RawError({ run, className = '' }: { run: Pick<FlowRun, 'error'>; className?: string }) {
  const error = rawError(run);
  return error ? <span className={`run-raw mono ${className}`.trim()}>{error}</span> : null;
}

/** Queues a failed run's step again (`POST /flow-runs/:runId/retry`), from its chat's banner or its item's link. */
export function useRetryRun(itemId: string) {
  const { t } = useTranslation('workItem');
  const toast = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.retryFlowRun(runId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.workItem(itemId) });
      void qc.invalidateQueries({ queryKey: keys.workItemRuns(itemId) });
    },
    onError: (error) => toast.error(t('run.retryFailed'), error),
  });
}
