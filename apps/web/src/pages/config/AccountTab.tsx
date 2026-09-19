import type { TokenSource } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { Select } from '../../components/controls';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, Field, Skeleton, Tag } from '../../components/ui';

const TOKEN_SOURCE_LABEL: Record<TokenSource, string> = {
  'wrapper-oauth-token': 'OAuth token configured here',
  'wrapper-api-key': 'API key configured here',
  'env-oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN from the container environment',
  'env-api-key': 'ANTHROPIC_API_KEY from the container environment',
  'credentials-file': 'credentials file from an interactive login',
  cswap: 'claude-swap: it owns the credential file and rotates between accounts',
  none: 'none',
};

export function AccountTab() {
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
      toast.success('Credential saved', 'It applies to every new run. Verify it with a real request.');
    },
    onError: (err) => toast.error('Could not save the credential', err),
  });
  const clear = useMutation({
    mutationFn: api.clearCredentials,
    onSuccess: () => {
      refresh();
      toast.success('Stored credential removed');
    },
    onError: (err) => toast.error('Could not remove the credential', err),
  });
  const verify = useMutation({
    mutationFn: api.verifyAuth,
    onSuccess: (result) => {
      refresh();
      if (result.ok) toast.success('The account works', 'A real request completed successfully.');
      else toast.error('Verification failed', new Error(result.detail));
    },
    onError: (err) => toast.error('Verification failed', err),
  });
  const fromWrapper = auth?.tokenSource.startsWith('wrapper-') ?? false;

  return (
    <>
      <Card title="Account in use">
        <ErrorBox error={error} />
        {isLoading && <Skeleton rows={4} />}
        {auth && (
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              {auth.loggedIn ? <Tag tone="ok">logged in</Tag> : <Tag tone="bad">logged out</Tag>} {auth.authMethod}
            </dd>
            <dt>Account</dt>
            <dd>{[auth.email, auth.orgName].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>Subscription</dt>
            <dd>{auth.subscriptionType ?? '—'}</dd>
            <dt>Credential</dt>
            <dd>{TOKEN_SOURCE_LABEL[auth.tokenSource]}</dd>
          </dl>
        )}
        <div className="form-actions">
          <button className="btn" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'Verifying…' : 'Verify with a real request'}
          </button>
          {fromWrapper && (
            <button className="btn btn-danger" disabled={clear.isPending} onClick={() => clear.mutate()}>
              Remove stored credential
            </button>
          )}
          {verify.data && (
            <span className={`small ${verify.data.ok ? 'text-ok' : 'text-err'}`}>
              {verify.data.ok ? 'Working' : `Failed: ${verify.data.detail}`}
            </span>
          )}
        </div>
        {auth?.tokenSource === 'cswap' && (
          <p className="small muted">
            claude-swap manages several accounts, so the wrapper injects no token of its own — a credential set here
            would override the active account. Switch accounts from <Link to="/accounts">Accounts</Link>.
          </p>
        )}
        <p className="small muted">
          “Logged in” only means a credential is configured; the CLI does not validate it. Use the verification to be
          sure.
        </p>
      </Card>

      <Card title="Set credential">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (secret.trim()) save.mutate();
          }}
        >
          <Field label="Type">
            <Select
              value={kind}
              onChange={setKind}
              options={[
                { value: 'oauthToken', label: 'Subscription OAuth token (claude setup-token)' },
                { value: 'apiKey', label: 'Anthropic API key' },
              ]}
            />
          </Field>
          <Field
            label={kind === 'oauthToken' ? 'OAuth token' : 'API key'}
            hint="Stored in the wrapper data volume and applied to every new run. It overrides credentials from the container environment and is never returned by the API."
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
              {save.isPending ? 'Saving…' : 'Save credential'}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}
