import type { WorkItemComment, WorkItemDetail } from '@agentry/shared';
import { Check, Hourglass, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProjectSettings } from '../../../api';
import { ICON_SM } from '../../../components/icons';
import { formatNumber } from '../../../lib/format';
import { RoleAvatar, useRoleName } from '../../documents/RoleTag';
import type { ItemActions } from './hooks';

/** The flow's default when a project never set one (`ProjectFlowSettings.maxBounces`). */
const DEFAULT_MAX_BOUNCES = 3;

/**
 * The role that verified the item, and its latest word on it: the `verify` chat's role, and that
 * role's newest comment. Null when no role verified it (the person moved it themselves).
 */
export function verifierOf(item: Pick<WorkItemDetail, 'links' | 'comments'>): { role: string | null; comment: WorkItemComment | null } {
  const verify = [...item.links].filter((link) => link.role === 'verify' && link.kind !== 'document').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const role = verify?.teamRole ?? null;
  const comment =
    [...item.comments]
      .filter((c) => c.author.kind === 'agent' && (role === null || c.author.role === role))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return { role, comment };
}

/** "Bounce 1 of 3": how many times verification sent the item back, neutral while it has some left. */
export function BounceMark({ bounces, max }: { bounces: number; max: number }) {
  const { t } = useTranslation('documents');
  return (
    <span className="bounce" title={t('waiting.bounceTitle', { n: formatNumber(bounces), max: formatNumber(max) })}>
      <Undo2 size={12} strokeWidth={2} aria-hidden />
      {t('waiting.bounce', { n: formatNumber(bounces), max: formatNumber(max) })}
    </span>
  );
}

/**
 * What the item waits for from the person under the flow by column (decisions 29 and 30), with the
 * action that ends it: QA passed it and only the person moves it to Done, or QA sent it back as many
 * times as the project allows. Any move the person makes clears the wait; an item that waits for
 * nothing but came back from QA shows its bounces, still.
 */
export function WaitingState({ item, actions }: { item: WorkItemDetail; actions: ItemActions }) {
  const { t } = useTranslation('documents');
  const roleName = useRoleName();
  const settings = useProjectSettings(item.projectId);
  const max = settings.data?.flow?.maxBounces ?? DEFAULT_MAX_BOUNCES;
  const bounces = item.bounces ?? 0;
  const waiting = item.waiting ?? null;
  if (!waiting && bounces === 0) return null;
  if (!waiting) {
    return (
      <div className="workitem-waiting is-quiet">
        <BounceMark bounces={bounces} max={max} />
      </div>
    );
  }

  const { role, comment } = verifierOf(item);
  const who = role ? roleName(role) : t('waiting.verification');
  const moving = actions.move.isPending;
  const approve = (
    <button type="button" className="btn btn-small workitem-approve" disabled={moving || item.status === 'done'} onClick={() => actions.move.mutate('done')}>
      <Check {...ICON_SM} />
      {t('waiting.approve')}
    </button>
  );
  const back = (
    <button type="button" className="btn btn-ghost btn-small workitem-send-back" disabled={moving} onClick={() => actions.move.mutate('in_progress')}>
      <Undo2 {...ICON_SM} />
      {t('waiting.sendBack')}
    </button>
  );

  return (
    <section className="workitem-waiting" role="status" aria-label={waiting === 'approval' ? t('waiting.approvalLabel') : t('waiting.bouncesLabel')}>
      <div className="workitem-waiting-head">
        <span className="badge badge-idle">
          <Hourglass size={11} strokeWidth={2} aria-hidden />
          {waiting === 'approval' ? t('waiting.approvalBadge') : t('waiting.bouncesBadge')}
        </span>
        <span className="workitem-waiting-why">
          {waiting === 'approval' ? t('waiting.approvalWhy', { who }) : t('waiting.bouncesWhy', { who, count: bounces, n: formatNumber(bounces) })}
        </span>
        {bounces > 0 && <BounceMark bounces={bounces} max={max} />}
      </div>
      {comment && (
        <blockquote className="workitem-waiting-quote">
          {role && <RoleAvatar role={role} size="sm" />}
          <span>{comment.body}</span>
        </blockquote>
      )}
      <p className="small muted workitem-waiting-hint">{waiting === 'approval' ? t('waiting.approvalHint') : t('waiting.bouncesHint')}</p>
      <div className="workitem-waiting-actions">
        {waiting === 'approval' ? (
          <>
            {approve}
            {back}
          </>
        ) : (
          <>
            {back}
            {approve}
          </>
        )}
      </div>
    </section>
  );
}
