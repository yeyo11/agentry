import type { AuditEntry, AuthConfig, AuthMode, OidcConfig } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, KeyRound, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Switch } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON, ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Card, CopyButton, Empty, ErrorBox, Field, Segmented, Skeleton, Tag } from '../../components/ui';
import { getToken, setChallenge, setToken } from '../../lib/auth';
import { formatDateTime, formatNumber } from '../../lib/format';
import { reveal, useRevealedToken } from '../../lib/revealed-token';

const MODES: AuthMode[] = ['none', 'token', 'oidc'];
const MIN_OWN_TOKEN = 16;
const AUDIT_PAGE = 25;
const NO_OIDC: OidcConfig = { issuer: '', audience: '', clientId: '' };

/**
 * Who may use this wrapper and what they may do. Everything here is administration of the guard
 * itself, so a mistake locks the person out of their own wrapper: the pieces that can do that ask
 * first, and say what the browser will be asked for afterwards.
 */
export function SecurityTab() {
  const { t } = useTranslation('config');
  const { data: auth, error, isLoading } = useQuery({ queryKey: keys.securityAuth, queryFn: api.securityAuth });

  return (
    <>
      <ErrorBox error={error} />
      {isLoading && (
        <Card>
          <Skeleton rows={5} />
        </Card>
      )}
      {auth && (
        <>
          <ReadOnlyCard auth={auth} />
          {/* Remounted from the server's copy whenever it changes, so the draft never outlives it */}
          <AccessCard key={JSON.stringify(auth)} auth={auth} />
          <TokenCard auth={auth} />
        </>
      )}
      <AuditCard />
      <p className="small muted">{t('security.footnote')}</p>
    </>
  );
}

function useAuthUpdate() {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.updateSecurityAuth,
    onSuccess: (config) => {
      queryClient.setQueryData(keys.securityAuth, config);
      void queryClient.invalidateQueries({ queryKey: ['security', 'audit'] });
    },
    onError: (err) => toast.error(t('security.saveFailed'), err),
  });
}

function ReadOnlyCard({ auth }: { auth: AuthConfig }) {
  const { t } = useTranslation('config');
  const toast = useToast();
  const update = useAuthUpdate();

  return (
    <Card
      title={t('security.readOnly.title')}
      actions={auth.readOnly ? <Tag tone="warn">{t('security.readOnly.on')}</Tag> : <Tag>{t('security.readOnly.off')}</Tag>}
    >
      <p className="small muted">{t('security.readOnly.intro')}</p>
      <Switch
        checked={auth.readOnly}
        disabled={update.isPending}
        onChange={(readOnly) =>
          update.mutate({ readOnly }, { onSuccess: () => toast.success(readOnly ? t('security.readOnly.enabled') : t('security.readOnly.disabled')) })
        }
      >
        {t('security.readOnly.label')}
      </Switch>
      {auth.readOnly && <p className="small muted">{t('security.readOnly.note')}</p>}
    </Card>
  );
}

function AccessCard({ auth }: { auth: AuthConfig }) {
  const { t } = useTranslation('config');
  const toast = useToast();
  const confirm = useConfirm();
  const update = useAuthUpdate();
  const [mode, setMode] = useState<AuthMode>(auth.mode);
  const [oidc, setOidc] = useState<OidcConfig>(auth.oidc ?? NO_OIDC);

  const oidcComplete = oidc.issuer.trim() !== '' && oidc.audience.trim() !== '';
  const oidcChanged = JSON.stringify(auth.oidc ?? NO_OIDC) !== JSON.stringify(oidc);
  // What the server would refuse: named up front instead of after the click
  const missing = mode === 'token' && !auth.tokenSet ? 'token' : mode === 'oidc' && !oidcComplete ? 'oidc' : null;
  const dirty = mode !== auth.mode || (mode === 'oidc' && oidcChanged);

  async function save() {
    if (missing) return;
    // Switching the guard on ends this browser's access unless it holds what the new mode wants
    if (mode !== auth.mode && mode !== 'none') {
      const ok = await confirm({
        title: t(`security.access.confirm.${mode}.title`),
        body: mode === 'token' && !getToken() ? t('security.access.confirm.token.noStoredToken') : t(`security.access.confirm.${mode}.body`),
        confirmLabel: t('security.access.confirm.action'),
      });
      if (!ok) return;
    }
    const cleaned: OidcConfig = { issuer: oidc.issuer.trim(), audience: oidc.audience.trim(), clientId: oidc.clientId.trim() };
    update.mutate({ mode, ...(mode === 'oidc' ? { oidc: cleaned } : {}) }, { onSuccess: () => toast.success(t('security.access.saved')) });
  }

  return (
    <Card title={t('security.access.title')} actions={<Tag tone={auth.mode === 'none' ? 'warn' : 'ok'}>{t(`security.access.modes.${auth.mode}.tag`)}</Tag>}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="small muted">{t('security.access.intro')}</p>
        <Segmented
          label={t('security.access.modeLabel')}
          value={mode}
          onChange={setMode}
          options={MODES.map((value) => ({ value, label: t(`security.access.modes.${value}.label`) }))}
        />
        <p className="small muted">{t(`security.access.modes.${mode}.body`)}</p>

        {mode === 'oidc' && (
          <>
            <div className="form-grid form-grid-3">
              <Field label={t('security.access.issuer')} hint={t('security.access.issuerHint')}>
                <input
                  type="url"
                  autoComplete="off"
                  placeholder="https://login.example.com/realms/agentry"
                  value={oidc.issuer}
                  onChange={(e) => setOidc({ ...oidc, issuer: e.target.value })}
                />
              </Field>
              <Field label={t('security.access.audience')} hint={t('security.access.audienceHint')}>
                <input type="text" autoComplete="off" placeholder="agentry" value={oidc.audience} onChange={(e) => setOidc({ ...oidc, audience: e.target.value })} />
              </Field>
              <Field label={t('security.access.clientId')} hint={t('security.access.clientIdHint')}>
                <input type="text" autoComplete="off" value={oidc.clientId} onChange={(e) => setOidc({ ...oidc, clientId: e.target.value })} />
              </Field>
            </div>
            <p className="small muted">{t('security.access.oidcNoLogin')}</p>
          </>
        )}

        {missing && (
          <div className="alert alert-warn" role="status">
            <div className="alert-body">{t(`security.access.missing.${missing}`)}</div>
          </div>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!dirty || Boolean(missing) || update.isPending}>
            {update.isPending ? t('shared.saving') : t('security.access.save')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setMode(auth.mode);
              setOidc(auth.oidc ?? NO_OIDC);
            }}
          >
            {t('shared.discard')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function TokenCard({ auth }: { auth: AuthConfig }) {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const revealed = useRevealedToken();
  const [own, setOwn] = useState<string | null>(null);

  const set = useMutation({
    mutationFn: async (token: string | undefined) => {
      const result = await api.setSecurityToken(token ? { token } : {});
      // The old token stopped working the moment the answer was written: this browser takes the new
      // one before anything else asks, or its next poll would be a 401 and the sign-in screen. An OIDC
      // wrapper wants a JWT here, which a static token would only get in the way of.
      if (auth.mode !== 'oidc') {
        setToken(result.token);
        setChallenge(null);
      }
      // A token the person typed is one they already have; only a generated one is shown
      if (!token) reveal(result.token);
      return result;
    },
    onSuccess: () => {
      setOwn(null);
      void queryClient.invalidateQueries({ queryKey: keys.securityAuth });
      void queryClient.invalidateQueries({ queryKey: ['security', 'audit'] });
      toast.success(t('config:security.token.saved'));
    },
    onError: (err) => toast.error(t('config:security.token.saveFailed'), err),
  });
  const clear = useMutation({
    mutationFn: api.clearSecurityToken,
    onSuccess: (config) => {
      queryClient.setQueryData(keys.securityAuth, config);
      toast.success(t('config:security.token.removed'));
    },
    onError: (err) => toast.error(t('config:security.token.removeFailed'), err),
  });

  async function generate() {
    // Rotating while the token is the credential cuts off everyone else who holds the old one
    if (auth.tokenSet && auth.mode === 'token') {
      const ok = await confirm({
        title: t('config:security.token.rotateConfirm.title'),
        body: t('config:security.token.rotateConfirm.body'),
        confirmLabel: t('config:security.token.rotate'),
        danger: true,
      });
      if (!ok) return;
    }
    reveal(null);
    set.mutate(undefined);
  }

  const ownTooShort = own !== null && own.trim().length < MIN_OWN_TOKEN;
  const busy = set.isPending || clear.isPending;

  return (
    <Card
      title={t('config:security.token.title')}
      actions={auth.tokenSet ? <Tag tone="ok">{t('config:security.token.set')}</Tag> : <Tag>{t('config:security.token.notSet')}</Tag>}
    >
      <p className="small muted">{t('config:security.token.intro')}</p>

      {revealed && (
        <div className="alert alert-warn" role="status">
          <KeyRound {...ICON} className="alert-icon" aria-hidden />
          <div className="alert-body">
            <strong>{t('config:security.token.shownOnce')}</strong>
            <div className="small">{t('config:security.token.shownOnceBody')}</div>
            <div className="form-actions">
              <code className="mono break" data-testid="new-token">
                {revealed}
              </code>
              <CopyButton text={revealed} label={t('config:security.token.copy')} />
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-small" onClick={() => reveal(null)}>
                {t('config:security.token.copied')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void generate()}>
          {auth.tokenSet ? t('config:security.token.rotate') : t('config:security.token.generate')}
        </button>
        <button type="button" className="btn" disabled={busy || own !== null} onClick={() => setOwn('')}>
          {t('config:security.token.own')}
        </button>
        {auth.tokenSet && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || auth.mode === 'token'}
            onClick={() => {
              void confirm({
                title: t('config:security.token.removeConfirm.title'),
                body: t('config:security.token.removeConfirm.body'),
                confirmLabel: t('config:security.token.remove'),
                danger: true,
              }).then((ok) => ok && clear.mutate());
            }}
          >
            {t('config:security.token.remove')}
          </button>
        )}
      </div>
      {auth.tokenSet && auth.mode === 'token' && <p className="small muted">{t('config:security.token.removeBlocked')}</p>}

      {own !== null && (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ownTooShort) set.mutate(own.trim());
          }}
        >
          <Field label={t('config:security.token.ownLabel')} hint={t('config:security.token.ownHint', { min: MIN_OWN_TOKEN })}>
            <input type="password" autoComplete="off" autoFocus value={own} onChange={(e) => setOwn(e.target.value)} />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={ownTooShort || busy}>
              {t('config:security.token.ownSave')}
            </button>
            <button type="button" className="btn" onClick={() => setOwn(null)}>
              {t('common:actions.cancel')}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** What a status code means for the person reading the list; the number alone says little at a glance. */
function outcome(status: number): { tone: 'ok' | 'warn' | 'bad'; key: 'ok' | 'unauthorized' | 'readOnly' | 'rejected' | 'failed' } {
  if (status < 400) return { tone: 'ok', key: 'ok' };
  if (status === 401 || status === 403) return { tone: 'warn', key: 'unauthorized' };
  if (status === 405) return { tone: 'warn', key: 'readOnly' };
  if (status < 500) return { tone: 'warn', key: 'rejected' };
  return { tone: 'bad', key: 'failed' };
}

function AuditCard() {
  const { t } = useTranslation(['config', 'common']);
  const [filter, setFilter] = useState('');
  const [path, setPath] = useState('');
  const [from, setFrom] = useState(0);

  // One request per pause in typing, not per keystroke
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPath(filter.trim());
      setFrom(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filter]);

  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: keys.audit({ from, path }),
    queryFn: () => api.audit({ limit: AUDIT_PAGE, from, path }),
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
  });
  const entries: AuditEntry[] = data?.entries ?? [];
  const total = data?.total ?? 0;
  const last = from + entries.length;

  return (
    <Card
      title={t('config:security.audit.title')}
      actions={
        <button type="button" className="icon-btn" aria-label={t('config:shared.refresh')} disabled={isFetching} onClick={() => void refetch()}>
          <RefreshCw {...ICON_SM} />
        </button>
      }
    >
      <p className="small muted">{t('config:security.audit.intro')}</p>
      <div className="filter-bar">
        <div className="search-field grow">
          <Search {...ICON_SM} />
          <input
            type="search"
            placeholder={t('config:security.audit.filterPlaceholder')}
            aria-label={t('config:security.audit.filterLabel')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={5} />
      ) : entries.length === 0 ? (
        <Empty title={path ? t('config:security.audit.noMatch') : t('config:security.audit.none')}>
          {path ? t('config:security.audit.noMatchHint') : t('config:security.audit.noneHint')}
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table" aria-label={t('config:security.audit.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('config:security.audit.when')}</th>
                  <th scope="col">{t('config:security.audit.actor')}</th>
                  <th scope="col">{t('config:security.audit.request')}</th>
                  <th scope="col">{t('config:security.audit.result')}</th>
                  <th scope="col">{t('config:security.audit.what')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const result = outcome(entry.status);
                  return (
                    <tr key={entry.id}>
                      <td className="small muted nowrap">{formatDateTime(entry.at)}</td>
                      <td className="small mono break">{entry.actor}</td>
                      <td>
                        <span className="strong">{entry.method}</span> <span className="small mono break">{entry.path}</span>
                      </td>
                      <td className="nowrap">
                        <Tag tone={result.tone}>
                          {entry.status} · {t(`config:security.audit.outcome.${result.key}`)}
                        </Tag>
                      </td>
                      <td className="small">{entry.summary}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-small" disabled={from === 0} onClick={() => setFrom(Math.max(0, from - AUDIT_PAGE))}>
              <ChevronLeft {...ICON_SM} aria-hidden />
              {t('config:security.audit.newer')}
            </button>
            <span className="small muted" role="status">
              {t('config:security.audit.range', { first: formatNumber(from + 1), last: formatNumber(last), total: formatNumber(total) })}
            </span>
            <button type="button" className="btn btn-small" disabled={last >= total} onClick={() => setFrom(from + AUDIT_PAGE)}>
              {t('config:security.audit.older')}
              <ChevronRight {...ICON_SM} aria-hidden />
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
