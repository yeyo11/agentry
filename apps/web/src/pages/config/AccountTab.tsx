import type { TokenSource } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { Select } from '../../components/controls';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, Field, Skeleton, Tag } from '../../components/ui';
import { CliCard } from './CliCard';
import { UpdatesCard } from './UpdatesCard';

const TOKEN_SOURCE_KEY = {
  'wrapper-oauth-token': 'wrapperOauthToken',
  'wrapper-api-key': 'wrapperApiKey',
  'env-oauth-token': 'envOauthToken',
  'env-api-key': 'envApiKey',
  'credentials-file': 'credentialsFile',
  cswap: 'cswap',
  none: 'none',
} as const satisfies Record<TokenSource, string>;

export function AccountTab() {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: auth, error, isLoading } = useQuery({ queryKey: keys.auth, queryFn: api.auth });
  const [kind, setKind] = useState<'oauthToken' | 'apiKey'>('oauthToken');
  const [secret, setSecret] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.auth });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
  };
  const save = useMutation({
    mutationFn: () => api.setCredentials({ [kind]: secret }),
    onSuccess: () => {
      setSecret('');
      refresh();
      toast.success(t('account.saved'), t('account.savedDetail'));
    },
    onError: (err) => toast.error(t('account.saveFailed'), err),
  });
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
        {auth?.tokenSource === 'cswap' && (
          <p className="small muted">
            <Trans t={t} i18nKey="account.cswapNote" components={{ anchor: <Link to="/accounts" /> }} />
          </p>
        )}
        <p className="small muted">
          {t('account.loggedInNote')}
        </p>
      </Card>

      <Card title={t('account.setCredential')}>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (secret.trim()) save.mutate();
          }}
        >
          <Field label={t('account.type')}>
            <Select
              value={kind}
              onChange={setKind}
              options={[
                { value: 'oauthToken', label: t('account.oauthOption') },
                { value: 'apiKey', label: t('account.apiKeyOption') },
              ]}
            />
          </Field>
          <Field
            label={kind === 'oauthToken' ? t('account.oauthToken') : t('account.apiKey')}
            hint={t('account.secretHint')}
          >
            <input
              type="password"
              autoComplete="off"
              placeholder={kind === 'oauthToken' ? 'sk-ant-oat01-…' : 'sk-ant-api03-…'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!secret.trim() || save.isPending}>
              {save.isPending ? t('shared.saving') : t('account.save')}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}
