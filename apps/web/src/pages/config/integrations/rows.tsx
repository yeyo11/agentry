import type { CodeHostId, CodeHostStatus, TrackerId, TrackerStatus } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, keys } from '../../../api';
import { ProgramMark } from '@agentry/ui/components/BrandMark';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { Tag } from '@agentry/ui/components/ui';
import { changeRequestWords } from '../../../lib/code-hosts';
import { isTrackerBuilt, keepsCredentials, trackerAction, trackerTone, trackerWords } from '../../../lib/trackers';
import type { TrackerActionKind } from '../../../lib/trackers';
import { STATE_TONE } from '../../../lib/provider-state';
import { hostTool } from '../../../lib/setup';
import { SignOutButton } from '../../../components/setup/SignOutButton';

// The rows of Settings → Integrations, a code host's CLI and a tracker, with their binary override.
// The setup assistant's "Code and work items" step lists the same rows (components/setup).

/**
 * The vendors' own pages: where each CLI is installed and where its sign-in is explained. A remedy
 * is a link, never a command to copy.
 */
export const LINKS: Record<CodeHostId, { install: string; signIn: string }> = {
  github: { install: 'https://cli.github.com', signIn: 'https://cli.github.com/manual/gh_auth_login' },
  gitlab: { install: 'https://gitlab.com/gitlab-org/cli#installation', signIn: 'https://docs.gitlab.com/cli/auth/login/' },
};

/** Where a tracker with a CLI of its own is installed: JetBrains' package for YouTrack. */
const OWN_INSTALL: Partial<Record<TrackerId, string>> = { youtrack: 'https://www.npmjs.com/package/@jetbrains/youtrack-apps-tools' };

/** The reasons only a tracker that keeps its own credentials gives; they are worded in the tracker's texts, not the host's. */
const OWN_REASONS = ['no-credentials', 'token-rejected', 'host-unreachable'] as const;
type OwnReason = (typeof OWN_REASONS)[number];
const isOwnReason = (reason: TrackerStatus['reason']): reason is OwnReason => (OWN_REASONS as readonly string[]).includes(reason ?? '');

/** States in which the program runs; anything else after "Check and save" means the path is refused. */
export const WORKS: ReadonlySet<string> = new Set(['ready', 'degraded', 'signed-out']);

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
const NUMBERING: Record<TrackerId, string> = { 'github-issues': '#12', 'gitlab-issues': '#12', youtrack: 'PROJ-12' };

/** What a person typed is a path Agentry can run: the server refuses anything that is not absolute. */
const isAbsolutePath = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

export function ExternalLinkText({ href, label }: { href: string; label: string }) {
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
  if (status.reason !== null && status.reason !== 'not-recorded' && !isOwnReason(status.reason)) return t(`reason.${status.reason}`, params);
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

export function HostRow({
  status,
  enabled,
  variant,
  open,
  checking,
  panel,
  onRetry,
  onChooseBinary,
  onSignIn,
}: {
  status: CodeHostStatus;
  enabled: boolean;
  variant: 'row' | 'cell';
  open: boolean;
  checking: boolean;
  panel: React.ReactNode;
  onRetry: () => void;
  /** Without it, "Choose binary" is not offered (the setup assistant) */
  onChooseBinary?: () => void;
  /**
   * Opens the sign-in panel for a host (null: the CLI's default, '': one the person names). With it,
   * Sign in stays in Agentry, a ready row offers another host, and each known host signs in or out.
   */
  onSignIn?: (host: string | null) => void;
}) {
  const { t } = useTranslation('integrations');
  const { t: tProviders } = useTranslation('providers');
  const { t: tTasks } = useTranslation('tasks');
  const { t: tSetup } = useTranslation('setup');
  const tool = hostTool(status.id);
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
            {onSignIn && enabled && !checking &&
              (host.signedIn === false ? (
                <button
                  type="button"
                  className="btn prov-quiet btn-small"
                  data-action="sign-in-host"
                  aria-label={tSetup('row.signInAria', { label: host.hostname })}
                  onClick={() => onSignIn(host.hostname)}
                >
                  {tSetup('row.signIn')}
                </button>
              ) : (
                <SignOutButton tool={tool} label={status.label} host={host.hostname} small />
              ))}
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

  const actions = (checking || !enabled ? [] : ACTIONS[status.state]).filter((kind) => kind !== 'choose-binary' || onChooseBinary);
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
        // The panel signs in to the host that is signed out, or the CLI's default
        return onSignIn ? (
          <button
            key={kind}
            type="button"
            className={className}
            data-action={kind}
            aria-pressed={open}
            aria-label={tSetup('row.signInAria', { label: status.label })}
            onClick={() => onSignIn(status.hosts.find((h) => h.signedIn === false)?.hostname ?? null)}
          >
            {tSetup('row.signIn')}
          </button>
        ) : (
          link(LINKS[status.id].signIn, t('row.signIn'))
        );
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

  if (onSignIn && enabled && !checking && (status.state === 'ready' || status.state === 'degraded')) {
    buttons.push(
      <button key="add-host" type="button" className="btn prov-quiet" data-action="add-host" aria-pressed={open} onClick={() => onSignIn('')}>
        {tSetup('row.addHost')}
      </button>,
    );
  }

  if (variant === 'cell') {
    return (
      <div className="prov-cell" data-host={status.id} data-state={shown}>
        <div className="prov-cell-head">
          <ProgramMark id={status.id} label={status.label} />
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
        <ProgramMark id={status.id} label={status.label} />
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
export function BinaryEditor({
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

/** The binary editor's words for a tracker: it names the tracker, and an empty path means its host's program, or the PATH for one with its own. */
export function trackerBinaryWords(t: TFunction<'integrations'>, status: TrackerStatus): BinaryWords {
  const tracker = trackerWords(status.id).label;
  if (status.host === null) {
    return {
      title: t('tracker.bin.title', { cli: status.cli, tracker }),
      placeholder: t('tracker.binOwn.placeholder', { cli: status.cli }),
      hint: t('tracker.binOwn.hint', { cli: status.cli, minimum: status.minimum ?? '' }),
      usePath: t('tracker.binOwn.usePath'),
      cleared: t('tracker.binOwn.cleared', { tracker, cli: status.cli }),
    };
  }
  const host = status.host === 'gitlab' ? 'GitLab' : 'GitHub';
  return {
    title: t('tracker.bin.title', { cli: status.cli, tracker }),
    placeholder: t('tracker.bin.placeholder', { host }),
    hint: t('tracker.bin.hint', { tracker, host, minimum: status.minimum ?? '' }),
    usePath: t('tracker.bin.usePath'),
    cleared: t('tracker.bin.cleared', { tracker, host }),
  };
}

/**
 * What a tracker with credentials of its own says, by state: the address it reaches and the account,
 * or what is missing. Null for a state the host's words already cover.
 */
function ownTrackerReason(t: TFunction<'integrations'>, status: TrackerStatus, host: string): string | null {
  if (status.state === 'ready') return t('tracker.reason.readyOwn', { host, cli: status.cli, user: status.user ?? '' });
  if (status.state === 'not-installed') return t('tracker.reason.notInstalledOwn', { cli: status.cli });
  if (isOwnReason(status.reason)) return t(`tracker.reason.${status.reason}`, { host });
  return null;
}

/** The reason of a tracker in words, outside a row: the toast after its access is saved. */
export function trackerReasonText(t: TFunction<'integrations'>, status: TrackerStatus, host: string): string {
  return ownTrackerReason(t, status, host) ?? status.reason ?? status.state;
}

/** The plain-words reason of a tracker row: its own for ready, off and not recorded, the CLI's otherwise. */
function useTrackerReason(status: TrackerStatus, enabled: boolean, accessHost: string): string {
  const { t } = useTranslation('integrations');
  const hostReason = useHostReason(status, true);
  const tracker = trackerWords(status.id).label;
  if (!enabled) return t('tracker.reason.disabled', { tracker });
  if (status.reason === 'not-recorded') return t('tracker.reason.not-recorded', { tracker, cli: status.cli });
  if (status.host === null) return ownTrackerReason(t, status, accessHost) ?? hostReason;
  if (status.state === 'ready') return t('tracker.reason.ready', { cli: status.cli, host: status.host === 'gitlab' ? 'GitLab' : 'GitHub' });
  return hostReason;
}

/**
 * One tracker: its readiness, the reason in words and one remedy. A tracker listed before its CLI is
 * recorded says so, with its reason and no action: nothing is built on a CLI nobody has seen.
 */
export function TrackerRow({
  status,
  enabled,
  variant,
  open,
  accessOpen,
  checking,
  panel,
  onRetry,
  onChooseBinary,
  onConnect,
}: {
  status: TrackerStatus;
  enabled: boolean;
  variant: 'row' | 'cell';
  open: boolean;
  /** Whether YouTrack's address and token are open under the row */
  accessOpen: boolean;
  checking: boolean;
  panel: React.ReactNode;
  onRetry: () => void;
  /** Without it, "Choose binary" is not offered (the setup assistant) */
  onChooseBinary?: () => void;
  onConnect: () => void;
}) {
  const { t } = useTranslation('integrations');
  const { t: tProviders } = useTranslation('providers');
  const words = trackerWords(status.id);
  const built = isTrackerBuilt(status.id);
  const own = keepsCredentials(status.id);
  const access = useQuery({ queryKey: keys.youtrackCredentials, queryFn: ({ signal }) => api.youtrackCredentials({ signal }), enabled: own });
  const reason = useTrackerReason(status, enabled, access.data?.host ?? '');
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
  const kinds: TrackerActionKind[] = remedy && (remedy !== 'choose-binary' || onChooseBinary) ? [remedy] : [];
  // Access that works can still be changed, after the remedy and before the binary
  if (!checking && own && enabled && remedy !== 'connect') kinds.push('connect');
  if (!checking && built && enabled && remedy !== 'choose-binary' && onChooseBinary) kinds.push('choose-binary');
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
      case 'install': {
        const install = hostLinks?.install ?? OWN_INSTALL[status.id];
        return install && link(install, t('row.install'));
      }
      case 'connect':
        return (
          <button key={kind} type="button" className={className} data-action={kind} aria-pressed={accessOpen} onClick={onConnect}>
            {remedy === 'connect' ? t('row.connect') : t('row.changeAccess')}
          </button>
        );
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
          <ProgramMark id={status.id} label={words.label} />
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
        <ProgramMark id={status.id} label={words.label} />
        {identity}
        {state}
        <div className="prov-actions">{buttons}</div>
      </div>
      {panel}
    </>
  );
}
