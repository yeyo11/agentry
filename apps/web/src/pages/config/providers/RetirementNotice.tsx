import type { ProviderStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useProjects } from '../../../api';
import { useConfirm } from '@agentry/ui/components/Dialog';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { CLAUDE_CODE_ID, SIGN_IN_SETTINGS_PATH } from '../../../lib/provider-state';

/**
 * The one-time notice for an install that used claude-swap: which account Claude Code keeps using
 * (the one claude-swap left active), what rotation does now, which projects had a policy that is
 * gone, and that claude-swap's own data was left alone. It waits for "Understood" and then never
 * comes back; the only thing it offers to remove is Agentry's own copy. Neutral on purpose: nothing
 * here is wrong, so no status colour and nothing that moves.
 */
export function RetirementNotice({ statuses }: { statuses: ProviderStatus[] }) {
  const { t } = useTranslation('providers');
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: keys.cswapRetirement, queryFn: () => api.cswapRetirement() });
  const projects = useProjects(false);

  const dismiss = useMutation({
    mutationFn: () => api.dismissCswapRetirement(),
    onError: (err) => toast.error(t('retire.failed'), err),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.cswapRetirement }),
  });
  const removeCopy = useMutation({
    mutationFn: () => api.removeCswapManagedCopy(),
    onSuccess: ({ removed }) => toast.success(t(removed ? 'retire.removed' : 'retire.nothingToRemove')),
    onError: (err) => toast.error(t('retire.failed'), err),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.cswapRetirement }),
  });

  const notice = state.data?.notice;
  if (!notice) return null;

  const account = statuses.find((s) => s.id === CLAUDE_CODE_ID)?.account ?? null;
  const named = notice.policyProjects.map((id) => ({ id, name: projects.data?.find((p) => p.id === id)?.name ?? id }));

  const askRemove = async () => {
    const ok = await confirm({
      title: t('retire.removeTitle'),
      body: t('retire.removeBody'),
      confirmLabel: t('retire.remove'),
      danger: true,
    });
    if (ok) removeCopy.mutate();
  };

  return (
    <section className="card retire" aria-labelledby="retire-title">
      <div className="retire-head">
        <span className="retire-icon" aria-hidden>
          <Info {...ICON_SM} />
        </span>
        <span className="retire-text">
          <h2 id="retire-title">{t('retire.title')}</h2>
          <span className="small muted">{t('retire.lead')}</span>
        </span>
        <button type="button" className="btn btn-small" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          {t('retire.dismiss')}
        </button>
      </div>
      <dl className="retire-facts">
        <dt>{t('retire.account.label')}</dt>
        <dd>
          {account ? <b>{account}</b> : t('retire.account.none')}
          {t('retire.account.body')}{' '}
          <Link to={SIGN_IN_SETTINGS_PATH} className="link-btn">
            {t('retire.account.link')}
          </Link>
        </dd>
        <dt>{t('retire.changed.label')}</dt>
        <dd>{t('retire.changed.body')}</dd>
        {named.length > 0 && (
          <>
            <dt>{t('retire.policies.label')}</dt>
            <dd>
              {t('retire.policies.body', { count: named.length })}
              <span className="retire-chips">
                {named.map((p) => (
                  <Link key={p.id} className="chip" to={`/?project=${encodeURIComponent(p.id)}&view=settings`}>
                    {p.name}
                  </Link>
                ))}
              </span>
            </dd>
          </>
        )}
        <dt>{t('retire.left.label')}</dt>
        <dd>{t('retire.left.body')}</dd>
      </dl>
      {notice.managedCopy && (
        <div className="retire-foot">
          <button type="button" className="btn btn-danger btn-small" disabled={removeCopy.isPending} onClick={() => void askRemove()}>
            <Trash2 {...ICON_SM} />
            {t('retire.remove')}
          </button>
          <span className="small muted grow">{t('retire.removeHint')}</span>
        </div>
      )}
    </section>
  );
}
