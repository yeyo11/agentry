import type { FlowStartWaitingResult, FlowWaiting, ProjectFlowSettings } from '@agentry/shared';
import type { TFunction } from 'i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Dialog } from '../../components/Dialog';
import { Sheet } from '../../components/controls';
import { WorkItemStatusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { columnMeta } from '../../lib/work-items';
import { RoleAvatar, useRoleName } from './RoleAvatar';

/**
 * Whether a save switches the flow on: the flow as it was saved before, not as the draft had it, so
 * toggling back and forth before saving asks nothing, and saving a flow already on asks nothing.
 */
export function switchesFlowOn(saved: Pick<ProjectFlowSettings, 'enabled'>, next: Pick<ProjectFlowSettings, 'enabled'>): boolean {
  return !saved.enabled && next.enabled;
}

/** The waiting cards to ask about after the flow was switched on; null when none wait or the count cannot be read. */
export async function waitingToAsk(read: () => Promise<FlowWaiting>): Promise<FlowWaiting | null> {
  try {
    const found = await read();
    return found.total > 0 ? found : null;
  } catch {
    // The flow is saved; a count that cannot be read asks nothing, as before this prompt existed
    return null;
  }
}

/** What the toast says after "Start them": how many start now and how many wait, each pluralised. */
export function startedMessage(result: FlowStartWaitingResult, t: TFunction<'team'>): string {
  if (result.queued === 0) return t('flow.waiting.startedNone');
  return t('flow.waiting.started', {
    now: t('flow.waiting.startingNow', { count: result.startingNow }),
    queue: t('flow.waiting.inQueue', { count: result.waiting }),
  });
}

/** The prompt's body: the reason, then one row per column with its role and how many cards wait there. */
export function FlowWaitingBody({ waiting }: { waiting: FlowWaiting }) {
  const { t } = useTranslation(['team', 'tasks']);
  const roleName = useRoleName();
  return (
    <div className="flow-waiting">
      <p>{t('flow.waiting.body')}</p>
      <ul className="flow-waiting-list">
        {waiting.columns.map((column) => (
          <li key={column.column} className="flow-waiting-row">
            <span className="flow-waiting-col">
              <WorkItemStatusIcon status={column.column} decorative />
              {t(`tasks:${columnMeta(column.column).label}`)}
            </span>
            <span className="flow-waiting-role">
              <RoleAvatar role={column.role} size="sm" />
              {roleName(column.role)}
            </span>
            <span className="flow-waiting-count">{t('flow.waiting.count', { count: column.count })}</span>
          </li>
        ))}
      </ul>
      <p className="field-hint">{t('flow.waiting.hint')}</p>
    </div>
  );
}

/**
 * Asked after a save switched the flow on while cards already sat in columns with a responsible
 * member. Switching it on is not a card entering a column, so without this they would never start
 * (docs/plans/flow-start-waiting.md). "Start them" queues one run per card; "Only new ones", Escape
 * and closing it all keep today's behaviour and call nothing. Nothing moves here: nothing is live
 * until the person says so.
 */
export function FlowWaitingPrompt({ projectId, waiting, phone, onClose }: { projectId: string; waiting: FlowWaiting; phone: boolean; onClose: () => void }) {
  const { t } = useTranslation('team');
  const toast = useToast();
  const queryClient = useQueryClient();

  const start = useMutation({
    mutationFn: () => api.startWaitingFlowRuns(projectId),
    onSuccess: (result) => {
      if (result.queued === 0) toast.info(startedMessage(result, t));
      else toast.success(startedMessage(result, t));
      onClose();
    },
    onError: (error) => {
      toast.error(t('flow.waiting.startFailed'), error);
      onClose();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.flow(projectId) }),
  });

  const title = t('flow.waiting.title', { count: waiting.total });
  const body = <FlowWaitingBody waiting={waiting} />;
  const startButton = (
    <button type="button" className="btn btn-primary" data-autofocus disabled={start.isPending} onClick={() => start.mutate()}>
      {t('flow.waiting.start')}
    </button>
  );
  const onlyNew = (
    <button type="button" className="btn" disabled={start.isPending} onClick={onClose}>
      {t('flow.waiting.onlyNew')}
    </button>
  );

  if (phone)
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={title}
        side="bottom"
        className="flow-waiting-sheet"
        footer={
          <div className="sheet-actions">
            {startButton}
            {onlyNew}
          </div>
        }
      >
        {body}
      </Sheet>
    );

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={520}
      footer={
        <>
          {onlyNew}
          {startButton}
        </>
      }
    >
      {body}
    </Dialog>
  );
}
