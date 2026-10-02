import type { CodeHostId, CodeHostsSettings, CodeHostStatus, TrackerId, TrackersSettings, TrackerStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, keys } from '../../api';
import { Sheet } from '@agentry/ui/components/controls';
import { ICON_SM, Monogram } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, Empty, ErrorBox, Skeleton, Tag } from '@agentry/ui/components/ui';
import { changeRequestWords } from '../../lib/code-hosts';
import { isTrackerBuilt, trackerAction, trackerEntry, trackerTone, trackerWords, TRACKER_IDS, withTrackerEntry } from '../../lib/trackers';
import type { TrackerActionKind } from '../../lib/trackers';
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
const WORKS: ReadonlySet<string> = new Set(['ready', 'degraded', 'signed-out']);

/** What the binary editor needs of a program, whether it is a code host's or a tracker's. */
interface ProgramStatus {
  cli: string;
  version: string | null;
  binaryPath: string | null;
  minimum: string | null;
  recorded: string[];
  reason: TrackerStatus['reason'];
  state: string;
}

/** The texts that differ between a host's binary and a tracker's, which falls back on its host's. */
interface BinaryWords {
  title: string;
  placeholder: string;
  hint: string;
  usePath: string;
  cleared: string;
}

type ActionKind = 'install' | 'update' | 'sign-in' | 'choose-binary' | 'retry';

/** The remedy per state, from the validated prototype; the first is the one the state asks for. */
const ACTIONS: Record<CodeHostStatus['state'], ActionKind[]> = {
  ready: [],
  degraded: ['choose-binary'],
  'signed-out': ['sign-in'],
  incompatible: ['update', 'choose-binary'],
  'not-installed': ['install', 'choose-binary'],
  unknown: ['retry'],
};

/** How each tracker writes an issue's number, as an example beside its name. */
const NUMBERING: Record<TrackerId, string> = { 'github-issues': '#12', 'gitlab-issues': '#12', jira: 'CW-22', youtrack: 'PROJ-12' };

const entryOf = (settings: CodeHostsSettings, id: CodeHostId) => settings.hosts[id] ?? { enabled: true, binaryPath: null };

const latestCheck = (list: Array<{ checkedAt: string }>): string | null =>
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
  const trackers = useQuery({ queryKey: keys.trackers, queryFn: () => api.trackers() });
  const trackerSettings = useQuery({ queryKey: keys.trackerSettings, queryFn: () => api.trackerSettings() });
  const refresh = useMutation({
    mutationFn: () => api.refreshHosts(),
    onSuccess: (fresh) => queryClient.setQueryData(keys.hosts, fresh),
  });
  // The trackers of GitHub and GitLab are read from their host's CLI, so both are read together
  const refreshTrackers = useMutation({
    mutationFn: () => api.refreshTrackers(),
    onSuccess: (fresh) => queryClient.setQueryData(keys.trackers, fresh),
  });
  const saveTrackers = useMutation({
    mutationFn: (next: TrackersSettings) => api.putTrackerSettings(next),
    onSuccess: (saved) => queryClient.setQueryData(keys.trackerSettings, saved),
    onError: (err) => toast.error(t('saveFailed'), err),
  });
  const save = useMutation({
    mutationFn: (next: CodeHostsSettings) => api.putHostSettings(next),
    onSuccess: (saved) => queryClient.setQueryData(keys.hostSettings, saved),
    onError: (err) => toast.error(t('saveFailed'), err),
  });
  // The row being read again: "all" after Check again, or the one whose binary was just chosen
  const [checking, setChecking] = useState<CodeHostId | 'all' | null>(null);
  const [binaryOf, setBinaryOf] = useState<CodeHostId | null>(null);
  const [trackerBinaryOf, setTrackerBinaryOf] = useState<TrackerId | null>(null);
  const [checkingTracker, setCheckingTracker] = useState<TrackerId | null>(null);

  const failed = hosts.error ?? settings.error ?? trackers.error ?? trackerSettings.error;
  if (failed) return <ErrorBox error={failed} />;
  if (!hosts.data || !settings.data || !trackers.data || !trackerSettings.data) return <Skeleton rows={4} />;

  const list = hosts.data;
  const current = settings.data;
  const trackerList = TRACKER_IDS.map((id) => trackers.data.find((s) => s.id === id)).filter((s): s is TrackerStatus => s !== undefined);
  const currentTrackers = trackerSettings.data;
  const checkedAt = latestCheck([...list, ...trackerList]);
  const trackersReady = trackerList.filter((s) => trackerEntry(currentTrackers, s.id).enabled && s.state === 'ready').length;
  const openTracker = trackerBinaryOf ? trackerList.find((s) => s.id === trackerBinaryOf) : undefined;
  const ready = list.filter((s) => entryOf(current, s.id).enabled && s.state === 'ready').length;
  const nothing = list.length > 0 && list.every((s) => s.state === 'not-installed' && entryOf(current, s.id).binaryPath === null) && binaryOf === null;
  const open = binaryOf ? list.find((s) => s.id === binaryOf) : undefined;

  const recheck = async (scope: CodeHostId | 'all'): Promise<CodeHostStatus[] | null> => {
    setChecking(scope);
    try {
      const [fresh] = await Promise.all([refresh.mutateAsync(), refreshTrackers.mutateAsync()]);
      return fresh;
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
      const [fresh] = await Promise.all([refresh.mutateAsync(), refreshTrackers.mutateAsync()]);
      const found = fresh.find((s) => s.id === id) ?? null;
      if (binaryPath !== null && found && !WORKS.has(found.state)) {
        await save.mutateAsync(withPath(previous.binaryPath));
        // Awaited so "Not saved" shows once the row reads the program put back, never the refused one
        await Promise.all([refresh.mutateAsync(), refreshTrackers.mutateAsync()]).catch(() => undefined);
      }
      return found;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(null);
    }
  };

  /**
   * The same for a tracker: its own binary, or none, which reads the one of its host. A refused
   * path is put back, as for the hosts.
   */
  const useTrackerBinary = async (id: TrackerId, binaryPath: string | null): Promise<TrackerStatus | null> => {
    const previous = trackerEntry(currentTrackers, id);
    const withPath = (path: string | null): TrackersSettings => withTrackerEntry(currentTrackers, id, { ...previous, binaryPath: path });
    setCheckingTracker(id);
    try {
      await saveTrackers.mutateAsync(withPath(binaryPath));
      const fresh = await refreshTrackers.mutateAsync();
      const found = fresh.find((s) => s.id === id) ?? null;
      if (binaryPath !== null && found && !WORKS.has(found.state)) {
        await saveTrackers.mutateAsync(withPath(previous.binaryPath));
        await refreshTrackers.mutateAsync().catch(() => undefined);
      }
      return found;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setCheckingTracker(null);
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
        onChooseBinary={() => {
          setTrackerBinaryOf(null);
          setBinaryOf((now) => (now === status.id ? null : status.id));
        }}
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

  const trackerRows = trackerList.map((status) => {
    const entry = trackerEntry(currentTrackers, status.id);
    return (
      <TrackerRow
        key={status.id}
        status={status}
        enabled={entry.enabled}
        variant={narrow ? 'cell' : 'row'}
        open={trackerBinaryOf === status.id}
        checking={checking === 'all' || checkingTracker === status.id}
        onRetry={() => void recheck('all')}
        onChooseBinary={() => {
          setBinaryOf(null);
          setTrackerBinaryOf((now) => (now === status.id ? null : status.id));
        }}
        panel={
          !narrow && trackerBinaryOf === status.id ? (
            <BinaryEditor
              key={status.id}
              status={status}
              saved={entry.binaryPath}
              busy={checkingTracker === status.id}
              words={trackerBinaryWords(t, status)}
              onUse={(path) => useTrackerBinary(status.id, path)}
              onDone={() => setTrackerBinaryOf(null)}
            />
          ) : null
        }
      />
    );
  });

  // The gradient border goes on what the screen is about: the trackers, unless the empty state has it
  const trackersCard = narrow ? (
    <section className={`card${nothing ? '' : ' grad-border'} prov-card`} aria-label={t('tracker.title')}>
      {trackerRows}
    </section>
  ) : (
    <Card
      className={nothing ? 'prov-card' : 'grad-border prov-card'}
      title={<span>{t('tracker.title')}</span>}
      actions={
        <span className="mono prov-summary">
          {t('tracker.total', { count: trackerList.length })} · {t('list.ready', { count: trackersReady })}
        </span>
      }
    >
      {trackerRows}
    </Card>
  );

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
        <section className="card prov-card" aria-label={t('list.aria')}>
          {rows}
        </section>
      ) : (
        <Card
          className="prov-card"
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
      <p className="prov-step-note host-missing">{t('tracker.note')}</p>
      {trackersCard}
      {missing}
      {narrow && openTracker && (
        <Sheet open onOpenChange={(next) => !next && setTrackerBinaryOf(null)} title={t('tracker.bin.title', { cli: openTracker.cli, tracker: trackerWords(openTracker.id).label })} className="prov-sheet">
          <BinaryEditor
            key={openTracker.id}
            status={openTracker}
            saved={trackerEntry(currentTrackers, openTracker.id).binaryPath}
            busy={checkingTracker === openTracker.id}
            words={trackerBinaryWords(t, openTracker)}
            onUse={(path) => useTrackerBinary(openTracker.id, path)}
            onDone={() => setTrackerBinaryOf(null)}
            sheet
          />
        </Sheet>
      )}
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
function useHostReason(status: ProgramStatus, enabled: boolean): string {
  const { t } = useTranslation('integrations');
  if (!enabled) return t('reason.disabled');
  const params = {
    cli: status.cli,
    version: status.version ?? '',
    minimum: status.minimum ?? '',
    recorded: status.recorded[status.recorded.length - 1] ?? '',
  };
  if (status.reason !== null && status.reason !== 'not-recorded') return t(`reason.${status.reason}`, params);
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
function metaLine(status: ProgramStatus): string {
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
  words,
  onUse,
  onDone,
  sheet = false,
}: {
  status: ProgramStatus;
  saved: string | null;
  busy: boolean;
  /** A tracker says whose binary it falls back on; a host's own texts are the default */
  words?: BinaryWords;
  onUse: (path: string | null) => Promise<ProgramStatus | null>;
  onDone: () => void;
  sheet?: boolean;
}) {
  const { t } = useTranslation('integrations');
  const toast = useToast();
  const [path, setPath] = useState(saved ?? status.binaryPath ?? '');
  const [refused, setRefused] = useState<ProgramStatus | null>(null);
  const [relative, setRelative] = useState(false);
  const trimmed = path.trim();
  const reason = useHostReason(refused ?? status, true);
  const title = words?.title ?? t('bin.title', { cli: status.cli });

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
    toast.success(words?.cleared ?? t('bin.cleared', { cli: status.cli }));
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
        placeholder={words?.placeholder ?? t('bin.placeholder', { cli: status.cli })}
        aria-label={t('bin.path', { cli: status.cli })}
        aria-invalid={relative}
        onChange={(event) => setPath(event.target.value)}
      />
    </label>
  );
  const hint = <span className="form-hint">{words?.hint ?? t('bin.hint', { minimum: status.minimum ?? '' })}</span>;
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
              {words?.usePath ?? t('bin.usePath')}
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
          {words?.usePath ?? t('bin.usePath')}
        </button>
      </div>
    </div>
  );
}

/** The binary editor's words for a tracker: it names the tracker, and an empty path means its host's program. */
function trackerBinaryWords(t: TFunction<'integrations'>, status: TrackerStatus): BinaryWords {
  const tracker = trackerWords(status.id).label;
  const host = status.host === 'gitlab' ? 'GitLab' : 'GitHub';
  return {
    title: t('tracker.bin.title', { cli: status.cli, tracker }),
    placeholder: t('tracker.bin.placeholder', { host }),
    hint: t('tracker.bin.hint', { tracker, host, minimum: status.minimum ?? '' }),
    usePath: t('tracker.bin.usePath'),
    cleared: t('tracker.bin.cleared', { tracker, host }),
  };
}

/** The plain-words reason of a tracker row: its own for ready, off and not recorded, the CLI's otherwise. */
function useTrackerReason(status: TrackerStatus, enabled: boolean): string {
  const { t } = useTranslation('integrations');
  const hostReason = useHostReason(status, true);
  const tracker = trackerWords(status.id).label;
  if (!enabled) return t('tracker.reason.disabled', { tracker });
  if (status.reason === 'not-recorded') return t('tracker.reason.not-recorded', { tracker, cli: status.cli });
  if (status.state === 'ready') return t('tracker.reason.ready', { cli: status.cli, host: status.host === 'gitlab' ? 'GitLab' : 'GitHub' });
  return hostReason;
}

/**
 * One tracker: its readiness, the reason in words and one remedy. Jira and YouTrack are listed as
 * not available yet, with their reason and no action: nothing is built on a CLI nobody has seen.
 */
function TrackerRow({
  status,
  enabled,
  variant,
  open,
  checking,
  panel,
  onRetry,
  onChooseBinary,
}: {
  status: TrackerStatus;
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
  const words = trackerWords(status.id);
  const built = isTrackerBuilt(status.id);
  const reason = useTrackerReason(status, enabled);
  const meta = metaLine(status);
  const tone = trackerTone(status, enabled);
  const shown = enabled ? status.state : 'disabled';

  const identity = (
    <div className="prov-id">
      <span className="prov-name">
        {words.label}
        <span className="mono t-xs host-noun">{NUMBERING[status.id]}</span>
      </span>
      <span className="prov-meta ellipsis" title={meta}>
        {meta}
      </span>
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
      <Tag tone={tone}>{built ? tProviders(`state.${shown}`) : t('tracker.notAvailable')}</Tag>
      <p className="prov-reason">{reason}</p>
      {!built && (
        <span className="mono t-xs host-noun">
          {status.state} · {status.reason ?? ''}
        </span>
      )}
    </div>
  );

  const remedy: TrackerActionKind | null = checking ? null : trackerAction(status, enabled);
  // A built tracker can always be pointed at another binary; the remedy its state asks for comes first
  const kinds: TrackerActionKind[] = remedy ? [remedy] : [];
  if (!checking && built && enabled && remedy !== 'choose-binary') kinds.push('choose-binary');
  const hostLinks = status.host ? LINKS[status.host] : null;
  const buttons = kinds.map((kind) => {
    const className = kind === remedy && kind !== 'choose-binary' ? 'btn' : 'btn btn-ghost';
    const link = (href: string, label: string) => (
      <a key={kind} className={className} href={href} target="_blank" rel="noopener noreferrer" data-action={kind}>
        {label}
        <ExternalLink {...ICON_SM} />
        <span className="sr-only"> ({t('row.opensNewTab')})</span>
      </a>
    );
    switch (kind) {
      case 'install':
        return hostLinks && link(hostLinks.install, t('row.install'));
      case 'sign-in':
        return hostLinks && link(hostLinks.signIn, t('row.signIn'));
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
      <div className="prov-cell" data-tracker={status.id} data-state={shown}>
        <div className="prov-cell-head">
          <Monogram name={words.label} />
          {identity}
        </div>
        {state}
        {buttons.length > 0 && <div className="prov-actions host-actions">{buttons}</div>}
      </div>
    );
  }
  return (
    <>
      <div className={`prov-row compact${open ? ' open' : ''}`} data-tracker={status.id} data-state={shown}>
        <Monogram name={words.label} />
        {identity}
        {state}
        <div className="prov-actions">{buttons}</div>
      </div>
      {panel}
    </>
  );
}
