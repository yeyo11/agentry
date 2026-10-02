import type { CodeHostId, CodeHostStatus, Project, ProjectWebhooks, WebhookRegistration } from '@agentry/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ExternalLink, Link2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, keys } from '../../api';
import { Dialog, useConfirm } from '@agentry/ui/components/Dialog';
import { ICON_SM, Monogram } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, ErrorBox, Skeleton, Tag } from '@agentry/ui/components/ui';
import { timeAgo } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { changeRequestWords } from '../../lib/code-hosts';
import {
  BACKUP_POLL_MINUTES,
  isWebhookBuilt,
  lastHeardAt,
  liveRegistration,
  POLL_MINUTES,
  responseWord,
  rowKind,
  UNAVAILABLE_REASON_KEYS,
  webhookActions,
  webhookTone,
} from '../../lib/webhooks';
import type { WebhookRowKind } from '../../lib/webhooks';

const HOST_LABEL: Record<CodeHostId, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** What the row shows: the kinds of the model, plus a registration the tunnel's absence left behind. */
type ShownKind = WebhookRowKind | 'gitlab';

/**
 * A registration can outlive the address it was made for: the project is then `unavailable` for
 * registering, yet the hook is still there and can be removed, so it reads as an old address.
 */
function shownKind(host: CodeHostId, overview: ProjectWebhooks): ShownKind {
  if (!isWebhookBuilt(host)) return 'gitlab';
  if (!overview.available && overview.reason === 'no-public-url' && liveRegistration(overview.registrations)) return 'stale';
  return rowKind(overview);
}

/**
 * Integrations → Webhooks: one row per project with a code host remote. A webhook only makes
 * Agentry read sooner; nothing here changes a pull request. The secret never reaches the page.
 */
export function WebhooksSection({ projects }: { projects: Project[] }) {
  const { t } = useTranslation('webhooks');
  const narrow = useMediaQuery(NARROW);
  const overviews = useQueries({
    queries: projects.map((project) => ({ queryKey: keys.projectWebhooks(project.id), queryFn: ({ signal }: { signal: AbortSignal }) => api.projectWebhooks(project.id, { signal }) })),
  });

  const failed = overviews.find((o) => o.isError)?.error;
  if (failed) return <ErrorBox error={failed} title={t('loadFailed')} />;
  if (overviews.some((o) => o.isLoading)) return <Skeleton rows={3} />;

  // A project without a remote has nothing to say here, so it is not a row
  const entries = projects.flatMap((project, at) => {
    const overview = overviews[at]?.data;
    return overview && overview.reason !== 'no-remote' ? [{ project, overview }] : [];
  });
  const withHook = entries.filter((e) => liveRegistration(e.overview.registrations) !== null).length;
  const publicUrl = entries.find((e) => e.overview.publicUrl)?.overview.publicUrl ?? null;
  // Only a GitHub project can use an address; GitLab's rows say their own reason
  const needsAddress = publicUrl === null && entries.some((e) => isWebhookBuilt(hostOf(e.overview)));

  const rows = entries.map(({ project, overview }) => <WebhookRow key={project.id} project={project} overview={overview} variant={narrow ? 'cell' : 'row'} />);
  const bar = publicUrl ? (
    <div className="wh-bar">
      <Link2 {...ICON_SM} aria-hidden />
      <span className="wh-bar-label">{t('arrive')}</span>
      <span className="wh-url mono">{publicUrl}</span>
      <span className="grow" />
      <Tag tone="ok">{t('open')}</Tag>
    </div>
  ) : needsAddress ? (
    <div className="wh-notice" role="status">
      <TriangleAlert {...ICON_SM} aria-hidden />
      <p>
        <strong>{t('noAddress.title')}</strong> {t('noAddress.body')}
      </p>
      <Link className="btn" to="/settings?tab=remote">
        {t('noAddress.link')}
        <ExternalLink {...ICON_SM} />
      </Link>
    </div>
  ) : null;

  return (
    <Card
      className="prov-card wh-card"
      title={<span>{t('title')}</span>}
      actions={<span className="mono prov-summary">{t('summary', { count: entries.length, active: withHook })}</span>}
    >
      {bar}
      {entries.length === 0 ? <p className="wh-none">{t('none')}</p> : <div role="list" aria-label={t('aria')}>{rows}</div>}
    </Card>
  );
}

/** The host a project's overview is about: its registration's, else GitHub, the only one built. */
function hostOf(overview: ProjectWebhooks): CodeHostId {
  return overview.reason === 'host-not-recorded' ? 'gitlab' : (overview.registrations[0]?.host ?? 'github');
}

function WebhookRow({ project, overview, variant }: { project: Project; overview: ProjectWebhooks; variant: 'row' | 'cell' }) {
  const { t } = useTranslation('webhooks');
  const { t: tTasks } = useTranslation('tasks');
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const remote = useQuery({ queryKey: keys.projectCodeHost(project.id), queryFn: ({ signal }) => api.projectCodeHost(project.id, { signal }) });
  const [registering, setRegistering] = useState(false);

  const reg = liveRegistration(overview.registrations);
  const host: CodeHostId = remote.data?.readiness.host ?? reg?.host ?? hostOf(overview);
  const kind = shownKind(host, overview);
  const actions = kind === 'gitlab' ? [] : kind === 'stale' && !overview.available ? ['remove' as const] : webhookActions(overview);
  const words = changeRequestWords(host);
  const label = HOST_LABEL[host];
  const repo = reg?.repoPath ?? remote.data?.remote?.path ?? '';

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.projectWebhooks(project.id) });
  const test = useMutation({
    mutationFn: (registration: WebhookRegistration) => api.testWebhook(project.id, registration.id),
    onSuccess: (done) => {
      const answer = responseWord(done) ?? '—';
      if (done.state === 'failing') toast.error(t('test.failed', { host: label, answer }));
      else toast.success(t('test.ok', { host: label, answer }));
    },
    onError: (err) => toast.error(t('test.error'), err),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (registration: WebhookRegistration) => api.removeWebhook(project.id, registration.id),
    onSuccess: () => toast.success(t('remove.done')),
    onError: (err) => toast.error(t('remove.error'), err),
    onSettled: refresh,
  });

  const askRemove = async (registration: WebhookRegistration) => {
    const ok = await confirm({
      title: t('remove.title', { project: project.name }),
      body: t('remove.body', { repo: registration.repoPath, host: label, count: POLL_MINUTES }),
      confirmLabel: t('remove.confirm'),
      danger: true,
    });
    if (ok) remove.mutate(registration);
  };

  const fact = (name: string, value: string, key: string) => (
    <div key={key}>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
  const facts: React.ReactNode[] = [];
  if (reg && kind !== 'gitlab') {
    const heard = lastHeardAt(reg);
    if (kind === 'failing') {
      const answer = reg.lastResponse ? (reg.lastResponse.code !== null ? `HTTP ${reg.lastResponse.code}` : (reg.lastResponse.status ?? '—')) : '—';
      facts.push(fact(t('fact.lastResponse'), `${answer}${heard ? ` · ${timeAgo(heard)}` : ''}`, 'response'));
    } else if (kind === 'stale') {
      facts.push(fact(t('fact.pointsTo'), reg.url, 'url'));
    } else {
      facts.push(fact(t('fact.lastNotice'), reg.lastDeliveryAt ? timeAgo(reg.lastDeliveryAt) : t('fact.noNotice'), 'notice'));
      if (reg.lastPingAt) facts.push(fact(t('fact.lastTest'), [responseWord(reg), timeAgo(reg.lastPingAt)].filter(Boolean).join(' · '), 'ping'));
    }
  }
  const backup = kind === 'active' || kind === 'failing' ? BACKUP_POLL_MINUTES : POLL_MINUTES;
  facts.push(fact(kind === 'active' ? t('fact.backup') : t('fact.read'), t('fact.every', { count: backup }), 'poll'));
  if (kind === 'gitlab') facts.push(fact(t('fact.reason'), `${overview.reason ?? ''}`, 'reason'));

  const text = (): string => {
    switch (kind) {
      case 'active':
        return t('text.active', { host: label });
      case 'failing':
        return t('text.failing', { host: label });
      case 'stale':
        return overview.available ? t('text.stale') : t('text.noAddressStale', { host: label });
      case 'gitlab':
        return t('text.gitlab', { count: POLL_MINUTES });
      case 'unavailable':
        return overview.reason === 'no-public-url' ? t('text.noAddress', { count: POLL_MINUTES }) : t(UNAVAILABLE_REASON_KEYS[overview.reason ?? 'no-remote']);
      case 'off':
        return t('text.off', { count: POLL_MINUTES });
    }
  };
  // No address means nothing is registered yet, which reads as off; only GitLab is "not available yet"
  const tag = kind === 'gitlab' ? t('state.unavailable') : kind === 'unavailable' ? t('state.off') : t(`state.${kind}`);
  const tone = kind === 'gitlab' || kind === 'unavailable' ? 'muted' : webhookTone(reg?.state ?? null);
  const busy = test.isPending || remove.isPending;

  const identity = (
    <div className="prov-id">
      <span className="prov-name">
        {project.name}
        <span className="mono t-xs host-noun">
          {tTasks(words.nounKey)} {words.prefix}12
        </span>
      </span>
      <span className="prov-meta ellipsis" title={repo}>
        {repo}
      </span>
    </div>
  );
  const state = (
    <div className="prov-state">
      <Tag tone={tone}>{tag}</Tag>
      <p className="prov-reason">{text()}</p>
      <dl className="wh-facts mono">{facts}</dl>
    </div>
  );
  const buttons = actions.map((action) => {
    switch (action) {
      case 'register':
        return (
          <button key={action} type="button" className="btn" data-action="register" onClick={() => setRegistering(true)}>
            {t('action.register')}
          </button>
        );
      case 'test':
        return (
          <button key={action} type="button" className="btn" data-action="test" disabled={busy || !reg} onClick={() => reg && test.mutate(reg)}>
            {test.isPending ? <Spinner /> : <Activity {...ICON_SM} />}
            {test.isPending ? t('action.testing') : t('action.test')}
          </button>
        );
      case 'remove':
        return (
          <button key={action} type="button" className="btn btn-ghost" data-action="remove" disabled={busy || !reg} onClick={() => reg && void askRemove(reg)}>
            {t('action.remove')}
          </button>
        );
    }
  });
  const dialog = registering && overview.publicUrl && (
    <RegisterDialog project={project} overview={overview} host={host} repo={repo} hostname={remote.data?.remote?.hostname ?? ''} onClose={() => setRegistering(false)} />
  );

  if (variant === 'cell') {
    return (
      <div className="prov-cell" role="listitem" data-project={project.id} data-kind={kind}>
        <div className="prov-cell-head">
          <Monogram name={label} />
          {identity}
        </div>
        {state}
        {buttons.length > 0 && <div className="prov-actions host-actions">{buttons}</div>}
        {dialog}
      </div>
    );
  }
  return (
    <div className="prov-row compact wh-row" role="listitem" data-project={project.id} data-kind={kind}>
      <Monogram name={label} />
      {identity}
      {state}
      <div className="prov-actions wh-actions">{buttons}</div>
      {dialog}
    </div>
  );
}

/**
 * What registering will do, shown before the person confirms: the address the host will deliver to,
 * the events, and what happens to the secret (it is made, kept and handed over, never shown).
 */
function RegisterDialog({ project, overview, host, repo, hostname, onClose }: { project: Project; overview: ProjectWebhooks; host: CodeHostId; repo: string; hostname: string; onClose: () => void }) {
  const { t } = useTranslation(['webhooks', 'common']);
  const toast = useToast();
  const queryClient = useQueryClient();
  const hosts = useQuery({ queryKey: keys.hosts, queryFn: ({ signal }) => api.hosts({ signal }) });
  const status: CodeHostStatus | undefined = hosts.data?.find((s) => s.id === host);
  const user = status?.hosts.find((h) => h.hostname === hostname)?.user ?? null;
  const label = HOST_LABEL[host];
  const cli = status?.cli ?? (host === 'github' ? 'gh' : 'glab');
  const [error, setError] = useState<unknown>(null);

  const register = useMutation({
    mutationFn: () => api.registerWebhook(project.id),
    onSuccess: () => {
      toast.success(t('register.done'));
      onClose();
    },
    onError: setError,
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.projectWebhooks(project.id) }),
  });

  // The receiver's path ends with an id Agentry only makes at registration, so the address is shown without it
  const address = `${overview.publicUrl ?? ''}/api/webhooks/${host}/`;
  const denied = error instanceof ApiRequestError && error.code === 'hook-no-permission';
  const subtitle = [repo, hostname, status?.version ? `${cli} ${status.version}` : cli].filter(Boolean).join(' · ');

  return (
    <Dialog
      width={660}
      onClose={onClose}
      title={
        <span className="wh-dlg-title">
          <Monogram name={label} />
          <span>
            {t('register.title', { project: project.name })}
            <span className="wh-dlg-sub mono">{subtitle}</span>
          </span>
        </span>
      }
      footer={
        <>
          <span className="wh-dlg-session">{user ? t('register.session', { cli, user }) : t('register.sessionPlain', { cli })}</span>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus disabled={register.isPending} onClick={() => register.mutate()}>
            {register.isPending && <Spinner />}
            {register.isPending ? t('register.submitting') : error ? t('register.retry') : t('register.submit')}
          </button>
        </>
      }
    >
      {/* The body scrolls on a phone and holds nothing to focus: it takes the focus itself, so the keyboard can read it */}
      <div className="wh-dlg" tabIndex={0} role="region" aria-label={t('register.title', { project: project.name })}>
        {error !== null && !register.isPending && (
          <div className="wh-notice" role="alert">
            <TriangleAlert {...ICON_SM} aria-hidden />
            <p>
              <strong>{denied ? t('register.noPermission', { host: label }) : t('register.failed')}</strong>{' '}
              {denied ? t('register.noPermissionBody', { cli }) : error instanceof Error ? error.message : ''}
            </p>
          </div>
        )}
        <section>
          <span className="section-label">{t('register.address')}</span>
          <div className="wh-field">
            <Link2 {...ICON_SM} aria-hidden />
            <span className="wh-url mono ellipsis">
              {address}
              <span className="wh-id">{t('register.addressId')}</span>
            </span>
          </div>
          <p className="form-hint">{t('register.addressNote', { host: label })}</p>
        </section>
        <section>
          <span className="section-label">{t('register.events')}</span>
          <ul className="wh-events">
            {overview.events.map((event) => (
              <li key={event}>
                <span className="mono">{event}</span>
                <span className="wh-event-note">{t(`event.${event}`, { defaultValue: '' })}</span>
              </li>
            ))}
          </ul>
          <p className="form-hint">{t('register.eventsNote')}</p>
        </section>
        <p className="wh-secret">{t('register.secret', { host: label })}</p>
      </div>
    </Dialog>
  );
}
