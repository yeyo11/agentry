import type { TokenSource } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, ErrorBox, Skeleton, Tag } from '@agentry/ui/components/ui';
import { SignInPanel } from '../../components/setup/SignInPanel';
import { CliCard } from './CliCard';
import { UpdatesCard } from './UpdatesCard';

const TOKEN_SOURCE_KEY = {
  'wrapper-oauth-token': 'wrapperOauthToken',
  'wrapper-api-key': 'wrapperApiKey',
  'env-oauth-token': 'envOauthToken',
  'env-api-key': 'envApiKey',
  'credentials-file': 'credentialsFile',
  none: 'none',
} as const satisfies Record<TokenSource, string>;

/** A product name, never translated */
const CLAUDE_CODE_LABEL = 'Claude Code';

export function AccountTab() {
  const { t } = useTranslation('config');
  const { t: tSetup } = useTranslation('setup');
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: auth, error, isLoading } = useQuery({ queryKey: keys.auth, queryFn: api.auth });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.auth });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
  };
  const clear = useMutation({
    mutationFn: api.clearCredentials,
    onSuccess: () => {
      refresh();
      toast.success(t('account.removed'));
    },
    onError: (err) => toast.error(t('account.removeFailed'), err),
  });
  const verify = useMutation({
    mutationFn: api.verifyAuth,
    onSuccess: (result) => {
      refresh();
      if (result.ok) toast.success(t('account.works'), t('account.worksDetail'));
      else toast.error(t('account.verifyFailed'), new Error(result.detail));
    },
    onError: (err) => toast.error(t('account.verifyFailed'), err),
  });
  const fromWrapper = auth?.tokenSource.startsWith('wrapper-') ?? false;

  return (
    <>
      <UpdatesCard />
      <CliCard />

      <Card title={t('account.inUse')}>
        <ErrorBox error={error} />
        {isLoading && <Skeleton rows={4} />}
        {auth && (
          <dl className="kv">
            <dt>{t('account.status')}</dt>
            <dd>
              {auth.loggedIn ? <Tag tone="ok">{t('account.loggedIn')}</Tag> : <Tag tone="bad">{t('account.loggedOut')}</Tag>}{' '}
              {auth.authMethod}
            </dd>
            <dt>{t('account.account')}</dt>
            <dd>{[auth.email, auth.orgName].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>{t('account.subscription')}</dt>
            <dd>{auth.subscriptionType ?? '—'}</dd>
            <dt>{t('account.credential')}</dt>
            <dd>{t(`account.tokenSource.${TOKEN_SOURCE_KEY[auth.tokenSource]}`)}</dd>
          </dl>
        )}
        <div className="form-actions">
          <button className="btn" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? t('account.verifying') : t('account.verify')}
          </button>
          {fromWrapper && (
            <button className="btn btn-danger" disabled={clear.isPending} onClick={() => clear.mutate()}>
              {t('account.remove')}
            </button>
          )}
          {/* Always rendered so a screen reader is told when the result lands */}
          <span className="small" role="status">
            {verify.data && (
              <span className={`meta-icon ${verify.data.ok ? 'text-ok' : 'text-err'}`}>
                {verify.data.ok ? <CircleCheck {...ICON_SM} /> : <CircleX {...ICON_SM} />}
                {verify.data.ok ? t('account.working') : t('account.failed', { detail: verify.data.detail })}
              </span>
            )}
          </span>
        </div>
        <p className="small muted">
          {t('account.loggedInNote')}
        </p>
      </Card>

      {/* The same panel as Settings → Providers and the setup assistant: the token, or an API key */}
      <Card title={tSetup('panel.title', { label: CLAUDE_CODE_LABEL })}>
        <SignInPanel tool="claude-code" label={CLAUDE_CODE_LABEL} layout="card" onClose={() => undefined} />
      </Card>
    </>
  );
}
