import type { CodeHostId, CodeHostsSettings, CodeHostState, CodeHostStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Sheet } from '@agentry/ui/components/controls';
import { ICON_SM, Monogram } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, Empty, ErrorBox, Skeleton, Tag } from '@agentry/ui/components/ui';
import { changeRequestWords } from '../../lib/code-hosts';
import { timeAgo } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { STATE_TONE } from '../../lib/provider-state';

/**
 * The vendors' own pages: where each CLI is installed and where its sign-in is explained. A remedy
 * is a link, never a command to copy.
 */
const LINKS: Record<CodeHostId, { install: string; signIn: string }> = {
  github: { install: 'https://cli.github.com', signIn: 'https://cli.github.com/manual/gh_auth_login' },
  gitlab: { install: 'https://gitlab.com/gitlab-org/cli#installation', signIn: 'https://docs.gitlab.com/cli/auth/login/' },
};

/** States in which the program runs; anything else after "Check and save" means the path is refused. */
const WORKS: ReadonlySet<CodeHostState> = new Set(['ready', 'degraded', 'signed-out']);

type ActionKind = 'install' | 'update' | 'sign-in' | 'choose-binary' | 'retry';

/** The remedy per state, from the validated prototype; the first is the one the state asks for. */
const ACTIONS: Record<CodeHostState, ActionKind[]> = {
  ready: [],
  degraded: ['choose-binary'],
  'signed-out': ['sign-in'],
  incompatible: ['update', 'choose-binary'],
  'not-installed': ['install', 'choose-binary'],
  unknown: ['retry'],
};

const entryOf = (settings: CodeHostsSettings, id: CodeHostId) => settings.hosts[id] ?? { enabled: true, binaryPath: null };

const latestCheck = (list: CodeHostStatus[]): string | null =>
  list.reduce<string | null>((latest, s) => (latest === null || s.checkedAt > latest ? s.checkedAt : latest), null);

/** What a person typed is a path Agentry can run: the server refuses anything that is not absolute. */
const isAbsolutePath = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/**
 * The code host CLIs Agentry reaches (gh, glab): each one's state in words, the host names it knows
 * with their accounts, and a binary of the person's own when the search cannot find one. Nothing is
 * stored but that path; the sessions are the programs' own.
 */
export function IntegrationsTab() {
  const { t } = useTranslation('integrations');
  const toast = useToast();
  const queryClient = useQueryClient();
  const narrow = useMediaQuery(NARROW);
  const hosts = useQuery({ queryKey: keys.hosts, queryFn: () => api.hosts() });
  const settings = useQuery({ queryKey: keys.hostSettings, queryFn: () => api.hostSettings() });
  const refresh = useMutation({
    mutationFn: () => api.refreshHosts(),
    onSuccess: (fresh) => queryClient.setQueryData(keys.hosts, fresh),
  });
  const save = useMutation({
    mutationFn: (next: CodeHostsSettings) => api.putHostSettings(next),
    onSuccess: (saved) => queryClient.setQueryData(keys.hostSettings, saved),
    onError: (err) => toast.error(t('saveFailed'), err),
  });
  // The row being read again: "all" after Check again, or the one whose binary was just chosen
  const [checking, setChecking] = useState<CodeHostId | 'all' | null>(null);
  const [binaryOf, setBinaryOf] = useState<CodeHostId | null>(null);

  if (hosts.error || settings.error) return <ErrorBox error={hosts.error ?? settings.error} />;
  if (!hosts.data || !settings.data) return <Skeleton rows={4} />;

  const list = hosts.data;
  const current = settings.data;
  const checkedAt = latestCheck(list);
  const ready = list.filter((s) => entryOf(current, s.id).enabled && s.state === 'ready').length;
  const nothing = list.length > 0 && list.every((s) => s.state === 'not-installed' && entryOf(current, s.id).binaryPath === null) && binaryOf === null;
  const open = binaryOf ? list.find((s) => s.id === binaryOf) : undefined;

  const recheck = async (scope: CodeHostId | 'all'): Promise<CodeHostStatus[] | null> => {
    setChecking(scope);
    try {
      return await refresh.mutateAsync();
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(null);
    }
  };

  /**
   * Point a CLI at a binary (or back at the PATH) and read it. A binary the detector rejects is not
   * kept: the previous choice is put back, so "Check and save" never leaves a broken program in
   * the settings.
   */
  const useBinary = async (id: CodeHostId, binaryPath: string | null): Promise<CodeHostStatus | null> => {
    const previous = entryOf(current, id);
    const withPath = (path: string | null): CodeHostsSettings => ({ hosts: { ...current.hosts, [id]: { ...previous, binaryPath: path } } });
    setChecking(id);
    try {
      await save.mutateAsync(withPath(binaryPath));
      const fresh = await refresh.mutateAsync();
      const found = fresh.find((s) => s.id === id) ?? null;
      if (binaryPath !== null && found && !WORKS.has(found.state)) {
        await save.mutateAsync(withPath(previous.binaryPath));
        void refresh.mutateAsync().catch(() => undefined);
      }
      return found;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(null);
    }
  };

  const toolbar = (
    <div className="prov-toolbar">
      <button type="button" className="btn" disabled={checking !== null} onClick={() => void recheck('all')}>
        {checking === 'all' ? <Spinner /> : <RefreshCw {...ICON_SM} />}
        {t('refresh')}
      </button>
      <span className="prov-checked mono">{checkedAt ? t('checkedAgo', { time: timeAgo(checkedAt) }) : t('notChecked')}</span>
    </div>
  );

  const rows = list.map((status) => {
    const entry = entryOf(current, status.id);
    return (
      <HostRow
        key={status.id}
        status={status}
        enabled={entry.enabled}
        variant={narrow ? 'cell' : 'row'}
        open={binaryOf === status.id}
        checking={checking === 'all' || checking === status.id}
        onRetry={() => void recheck(status.id)}
        onChooseBinary={() => setBinaryOf((now) => (now === status.id ? null : status.id))}
        panel={
          !narrow && binaryOf === status.id ? (
            <BinaryEditor
              key={status.id}
              status={status}
              saved={entry.binaryPath}
              busy={checking === status.id}
              onUse={(path) => useBinary(status.id, path)}
              onDone={() => setBinaryOf(null)}
            />
          ) : null
        }
      />
    );
  });

  const missing = (
    <p className="prov-step-note host-missing">
      {t('missing.text')}
      <ExternalLinkText href={LINKS.github.signIn} label={t('missing.link')} />
    </p>
  );

  return (
    <div className="prov-page">
      {narrow && <p className="host-intro">{t('intro')}</p>}
      {toolbar}
      {nothing ? (
        <Card className="grad-border prov-card" title={<span>{t('list.title')}</span>}>
          <Empty
            illustration="cli-missing"
            tone="warn"
            title={t('empty.title')}
            action={
              <>
                <a className="btn btn-primary" href={LINKS.github.install} target="_blank" rel="noopener noreferrer">
                  {t('empty.install')}
                  <ExternalLink {...ICON_SM} />
                  <span className="sr-only"> ({t('row.opensNewTab')})</span>
                </a>
                <button type="button" className="btn" disabled={checking !== null} onClick={() => void recheck('all')}>
                  {t('refresh')}
                </button>
              </>
            }
          >
            {t('empty.body')}
          </Empty>
          <div className="host-also">
            <span className="section-label">{t('empty.also')}</span>
            <div className="host-also-chips">
              <a className="chip" href={LINKS.gitlab.install} target="_blank" rel="noopener noreferrer">
                {t('empty.installGlab')}
                <span className="sr-only"> ({t('row.opensNewTab')})</span>
              </a>
              <button type="button" className="chip" onClick={() => setBinaryOf(list[0]?.id ?? null)}>
                {t('empty.chooseBinary')}
              </button>
            </div>
          </div>
        </Card>
      ) : narrow ? (
        <section className="card grad-border prov-card" aria-label={t('list.aria')}>
          {rows}
        </section>
      ) : (
        <Card
          className="grad-border prov-card"
          title={<span>{t('list.title')}</span>}
          actions={
            <span className="mono prov-summary">
              {t('list.total', { count: list.length })} · {t('list.ready', { count: ready })}
            </span>
          }
        >
          {rows}
        </Card>
      )}
      {missing}
      {narrow && open && (
        <Sheet open onOpenChange={(next) => !next && setBinaryOf(null)} title={t('bin.title', { cli: open.cli })} className="prov-sheet">
          <BinaryEditor
            key={open.id}
            status={open}
            saved={entryOf(current, open.id).binaryPath}
            busy={checking === open.id}
            onUse={(path) => useBinary(open.id, path)}
            onDone={() => setBinaryOf(null)}
            sheet
          />
        </Sheet>
      )}
    </div>
  );
}

function ExternalLinkText({ href, label }: { href: string; label: string }) {
  const { t } = useTranslation('integrations');
  return (
    <a className="c-accent host-link" href={href} target="_blank" rel="noopener noreferrer">
      {label}
      <ExternalLink {...ICON_SM} />
      <span className="sr-only"> ({t('row.opensNewTab')})</span>
    </a>
  );
}

/** The plain-words reason under the state, from the code the detector gave. */
function useHostReason(status: CodeHostStatus, enabled: boolean): string {
  const { t } = useTranslation('integrations');
  if (!enabled) return t('reason.disabled');
  const params = {
    cli: status.cli,
    version: status.version ?? '',
    minimum: status.minimum,
    recorded: status.recorded[status.recorded.length - 1] ?? '',
  };
  if (status.reason !== null) return t(`reason.${status.reason}`, params);
  switch (status.state) {
    case 'ready':
      return t('reason.ready');
    case 'signed-out':
      return t('reason.signed-out', params);
    case 'not-installed':
      return t('reason.not-installed', params);
    default:
      return t('reason.unknown', params);
  }
}

/** The version and the path in mono, "gh 2.92.0 · /usr/bin/gh"; either may be missing. */
function metaLine(status: CodeHostStatus): string {
  return [[status.cli, status.version].filter(Boolean).join(' '), status.binaryPath].filter((part): part is string => Boolean(part)).join(' · ');
}

function HostRow({
  status,
  enabled,
  variant,
  open,
  checking,
  panel,
  onRetry,
  onChooseBinary,
}: {
  status: CodeHostStatus;
  enabled: boolean;
  variant: 'row' | 'cell';
  open: boolean;
  checking: boolean;
  panel: React.ReactNode;
  onRetry: () => void;
  onChooseBinary: () => void;
}) {
  const { t } = useTranslation('integrations');
  const { t: tProviders } = useTranslation('providers');
  const { t: tTasks } = useTranslation('tasks');
  const words = changeRequestWords(status.id);
  const reason = useHostReason(status, enabled);
  const shown = enabled ? status.state : 'disabled';
  const meta = metaLine(status);

  const identity = (
    <div className="prov-id">
      <span className="prov-name">
        {status.label}
        <span className="mono t-xs host-noun">
          {tTasks(words.nounKey)} {words.prefix}12
        </span>
      </span>
      <span className="prov-meta ellipsis" title={meta}>
        {meta}
      </span>
    </div>
  );

  const known = status.hosts.length > 0 && (
    <div className="host-known" role="group" aria-label={t('hosts.group', { cli: status.cli })}>
      <span className="section-label">{t('hosts.group', { cli: status.cli })}</span>
      <ul>
        {status.hosts.map((host) => (
          <li key={host.hostname}>
            <span className="host-name">{host.hostname}</span>
            {host.signedIn === false ? (
              <Tag tone="warn">{t('hosts.signedOut')}</Tag>
            ) : (
              host.user && <span className="host-user">{host.user}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  const state = checking ? (
    <div className="prov-state" role="status">
      <span className="prov-checking">
        <Spinner />
        {t('row.checking')}
      </span>
    </div>
  ) : (
    <div className="prov-state">
      <Tag tone={STATE_TONE[shown]}>{tProviders(`state.${shown}`)}</Tag>
      <p className="prov-reason">{reason}</p>
      {known}
    </div>
  );

  const actions = checking || !enabled ? [] : ACTIONS[status.state];
  const buttons = actions.map((kind, at) => {
    const className = at === 0 ? 'btn' : 'btn btn-ghost';
    const link = (href: string, label: string) => (
      <a key={kind} className={className} href={href} target="_blank" rel="noopener noreferrer" data-action={kind}>
        {label}
        <ExternalLink {...ICON_SM} />
        <span className="sr-only"> ({t('row.opensNewTab')})</span>
      </a>
    );
    switch (kind) {
      case 'install':
        return link(LINKS[status.id].install, t('row.install'));
      case 'update':
        return link(LINKS[status.id].install, t('row.update'));
      case 'sign-in':
        return link(LINKS[status.id].signIn, t('row.signIn'));
      case 'choose-binary':
        return (
          <button key={kind} type="button" className={className} data-action={kind} aria-pressed={open} onClick={onChooseBinary}>
            {t('row.chooseBinary')}
          </button>
        );
      case 'retry':
        return (
          <button key={kind} type="button" className={className} data-action={kind} onClick={onRetry}>
            <RefreshCw {...ICON_SM} />
            {t('row.retry')}
          </button>
        );
    }
  });

  if (variant === 'cell') {
    return (
      <div className="prov-cell" data-host={status.id} data-state={shown}>
        <div className="prov-cell-head">
          <Monogram name={status.label} />
          {identity}
        </div>
        {state}
        {buttons.length > 0 && <div className="prov-actions host-actions">{buttons}</div>}
      </div>
    );
  }
  return (
    <>
      <div className={`prov-row compact${open ? ' open' : ''}`} data-host={status.id} data-state={shown}>
        <Monogram name={status.label} />
        {identity}
        {state}
        <div className="prov-actions">{buttons}</div>
      </div>
      {panel}
    </>
  );
}

/**
 * The binary override: the path Agentry runs instead of searching the PATH. On desktop it opens
 * under the row; on a phone it fills a sheet.
 */
function BinaryEditor({
  status,
  saved,
  busy,
  onUse,
  onDone,
  sheet = false,
}: {
  status: CodeHostStatus;
  saved: string | null;
  busy: boolean;
  onUse: (path: string | null) => Promise<CodeHostStatus | null>;
  onDone: () => void;
  sheet?: boolean;
}) {
  const { t } = useTranslation('integrations');
  const toast = useToast();
  const [path, setPath] = useState(saved ?? status.binaryPath ?? '');
  const [refused, setRefused] = useState<CodeHostStatus | null>(null);
  const [relative, setRelative] = useState(false);
  const trimmed = path.trim();
  const reason = useHostReason(refused ?? status, true);
  const title = t('bin.title', { cli: status.cli });

  const check = async () => {
    setRefused(null);
    if (!isAbsolutePath(trimmed)) return setRelative(true);
    setRelative(false);
    const found = await onUse(trimmed);
    if (!found) return;
    if (WORKS.has(found.state)) {
      toast.success(t('bin.saved', { cli: status.cli }));
      onDone();
    } else {
      setRefused(found);
    }
  };
  const usePath = async () => {
    setRefused(null);
    setRelative(false);
    const found = await onUse(null);
    if (!found) return;
    toast.success(t('bin.cleared', { cli: status.cli }));
    onDone();
  };

  const field = (
    <label className="field field-mono grow">
      {sheet && <span className="field-label">{title}</span>}
      <input
        className="mono"
        value={path}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={t('bin.placeholder', { cli: status.cli })}
        aria-label={t('bin.path', { cli: status.cli })}
        aria-invalid={relative}
        onChange={(event) => setPath(event.target.value)}
      />
    </label>
  );
  const hint = <span className="form-hint">{t('bin.hint', { minimum: status.minimum })}</span>;
  const problem = (relative || refused) && (
    <p className="field-error" role="alert">
      {relative ? t('bin.absolute') : t('bin.rejected', { reason })}
    </p>
  );
  const submit = (
    <button type="button" className={sheet ? 'btn btn-primary' : 'btn'} disabled={busy || trimmed === ''} onClick={() => void check()}>
      {busy && <Spinner />}
      {busy ? t('bin.checking') : t('bin.check')}
    </button>
  );

  if (sheet) {
    return (
      <div className="prov-sheet-body">
        {field}
        {hint}
        {problem}
        <div className="prov-sheet-actions">
          {submit}
          <div className="prov-sheet-row">
            <button type="button" className="btn prov-quiet" disabled={busy} onClick={() => void usePath()}>
              {t('bin.usePath')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prov-bin host-bin" role="group" aria-label={title}>
      <span className="section-label">{title}</span>
      {field}
      {hint}
      {problem}
      <div className="prov-bin-actions">
        {submit}
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          {t('bin.cancel')}
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void usePath()}>
          {t('bin.usePath')}
        </button>
      </div>
    </div>
  );
}
