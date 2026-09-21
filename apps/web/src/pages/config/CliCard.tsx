import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Card, ErrorBox, Skeleton, Tag } from '../../components/ui';
import { timeAgo } from '../../lib/format';

/**
 * Which Claude Code this wrapper runs and whether a newer one is out. Reading is free; the registry
 * is only asked by the button (and once a day by the server), so opening this tab costs nothing.
 */
export function CliCard() {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const { data: info, error, isLoading } = useQuery({ queryKey: keys.cliVersion, queryFn: api.cliVersion });
  const check = useMutation({
    mutationFn: api.checkCliVersion,
    onSuccess: (fresh) => queryClient.setQueryData(keys.cliVersion, fresh),
  });
  const shown = check.data ?? info;

  return (
    <Card title={t('cli.title')}>
      <ErrorBox error={error} />
      {isLoading && <Skeleton rows={3} />}
      {shown && (
        <dl className="kv">
          <dt>{t('cli.version')}</dt>
          <dd>{shown.current ?? t('cli.notInstalled')}</dd>
          <dt>{t('cli.pinned')}</dt>
          <dd>{shown.pinned ?? t('cli.notPinned')}</dd>
          <dt>{t('cli.latest')}</dt>
          <dd>
            {shown.latest ?? t('cli.never')}{' '}
            {shown.latest &&
              (shown.updateAvailable ? <Tag tone="warn">{t('cli.updateAvailable', { latest: shown.latest })}</Tag> : <Tag tone="ok">{t('cli.upToDate')}</Tag>)}
          </dd>
        </dl>
      )}
      {shown?.updateAvailable && <p className="small">{t('cli.updateHow', { latest: shown.latest })}</p>}
      <div className="form-actions">
        <button className="btn" disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? t('cli.checking') : t('cli.check')}
        </button>
        {/* Always rendered so a screen reader is told when the answer lands */}
        <span className="small muted" role="status">
          {shown?.checkedAt && t('cli.checked', { when: timeAgo(shown.checkedAt) })}
        </span>
      </div>
      <ErrorBox title={t('cli.checkFailed')} error={check.error ?? (shown?.error ? new Error(shown.error) : null)} />
      <p className="small muted">{t('cli.note')}</p>
    </Card>
  );
}
