import type { ChangeRequestChecks, Check, WorkItemPullRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleAlert, ExternalLink, Minus, RefreshCw, Send, Sparkles, SquareX, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../../../api';
import { MoreActions, Sheet, type MenuEntry } from '@agentry/ui/components/controls';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { formatHour } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import {
  checkDurationMs,
  checkMark,
  checksActions,
  clockOf,
  countChecks,
  fixStage,
  groupChecks,
  isFailure,
  isManual,
  type CheckGroup,
  type CheckGroupId,
} from '../../../lib/change-requests';
import { CiBadge, useChangeRequestWords } from '../board/PullRequest';
import { CheckLogBody, CheckLogPanel, CheckMarkIcon, checkFacts, markBadge } from './CheckLog';

/** Failed and running groups open, the quiet ones folded away while there is something to look at. */
const quietFolded = (groups: CheckGroup[]) => groups.some((g) => g.id === 'failed' || g.id === 'running');


/** The checks of an open change request, the one read the section, the header and the fix share. */
export function useChangeRequestChecks(pr: Pick<WorkItemPullRequest, 'id' | 'phase'> | null | undefined) {
  const id = pr?.phase === 'open' ? pr.id : undefined;
  return useQuery({
    queryKey: keys.changeRequestChecks(id ?? ''),
    queryFn: ({ signal }) => api.changeRequestChecks(id ?? '', false, { signal }),
    enabled: !!id,
    // Not retried: a host that is down or rate limited says so on the page, instead of leaving it empty
    retry: false,
  });
}

/**
 * Whether "Fix failing checks" is on the page. The header's "Work on it" gives up its gradient while
 * it is: a desktop screen has two gradient surfaces at most, and the zone's one action is this.
 */
export function useFixOffered(pr: WorkItemPullRequest | null | undefined): boolean {
  const list = useChangeRequestChecks(pr);
  return !!pr && !!list.data && checksActions(list.data, pr).fix;
}

/** One `now` per second while a check runs, so its clock counts; nothing ticks when none does. */
function useRunningClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

function CheckRow({
  check,
  now,
  open,
  entries,
  onOpen,
}: {
  check: Check;
  now: number;
  open: boolean;
  entries: MenuEntry[];
  onOpen: () => void;
}) {
  const { t } = useTranslation('checks');
  const mark = checkMark(check);
  const ms = checkDurationMs(check, now);
  const clock = ms === null ? '—' : clockOf(ms);
  const word = <span className={mark.tone === 'idle' && check.state === 'queued' ? 'badge' : markBadge(mark.tone)}>{t(mark.label)}</span>;
  return (
    <div className={`check-row ${open ? 'on' : ''} ${mark.tone === 'live' ? 'live-rail' : ''}`.trim()}>
      <button type="button" className="check-main" aria-expanded={open} aria-controls={open ? 'check-log' : undefined} aria-label={t('row.viewLog', { name: check.name })} onClick={onOpen}>
        <CheckMarkIcon check={check} />
        <span className="check-name">
          <b>{check.name}</b>
          {check.group && <span className="stage">{check.group}</span>}
        </span>
        {/* On a phone the word, the stage and the clock sit on a second line */}
        <span className="meta">
          {word}
          {check.group && <span className="stage">{check.group}</span>}
          <span className="grow" />
          <span className="check-dur">{clock}</span>
        </span>
      </button>
      <MoreActions className="check-more" label={t('row.more', { name: check.name })} title={check.name} entries={entries} />
    </div>
  );
}

/** The group heads and rows of the list; each group folds on its own. */
function CheckList({
  groups,
  now,
  openId,
  rowEntries,
  onOpen,
}: {
  groups: CheckGroup[];
  now: number;
  openId: string | null;
  rowEntries: (check: Check) => MenuEntry[];
  onOpen: (check: Check) => void;
}) {
  const { t } = useTranslation('checks');
  const [toggled, setToggled] = useState<Partial<Record<CheckGroupId, boolean>>>({});
  const folded = quietFolded(groups);
  return (
    <div className="check-list" role="group" aria-label={t('title')}>
      {groups.map((group) => {
        // A group the person opened or closed stays so; the quiet ones start closed beside a failure
        const open = toggled[group.id] ?? (group.id === 'failed' || group.id === 'running' || !folded);
        const Chevron = open ? ChevronDown : ChevronRight;
        return (
          <div key={group.id} className="check-group">
            <button type="button" className="check-group-head" aria-expanded={open} onClick={() => setToggled((prev) => ({ ...prev, [group.id]: !open }))}>
              <Chevron {...ICON_SM} className="chevron" />
              <span className="label">{t(`group.${group.id}`)}</span>
              <span className="n">{group.allowed > 0 ? t('group.withAllowed', { total: group.checks.length, count: group.allowed }) : group.checks.length}</span>
            </button>
            {open &&
              group.checks.map((check) => <CheckRow key={check.id} check={check} now={now} open={openId === check.id} entries={rowEntries(check)} onOpen={() => onOpen(check)} />)}
          </div>
        );
      })}
    </div>
  );
}

/** Which checks "Fix failing checks" sends, and what is left out of it, before anything starts. */
function FixDialog({ list, pr, busy, onStart, onClose }: { list: ChangeRequestChecks; pr: WorkItemPullRequest; busy: boolean; onStart: () => void; onClose: () => void }) {
  const { t } = useTranslation('checks');
  const failures = list.checks.filter(isFailure);
  const allowed = list.checks.filter((c) => c.state === 'failed' && c.allowedToFail);
  // Attempts count per head: a new commit starts again from none
  const used = pr.fixHead && pr.fixHead === list.headSha ? (pr.fixAttempts ?? 0) : 0;
  return (
    <Dialog
      title={t('fix.title', { count: failures.length })}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('fix.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus disabled={busy} onClick={onStart}>
            <Sparkles {...ICON_SM} />
            {t('fix.start', { count: failures.length })}
          </button>
        </>
      }
    >
      <div className="form">
        <p className="muted small">{t('fix.intro')}</p>
        <ul className="fix-checks" aria-label={t('title')}>
          {failures.map((check) => (
            <li key={check.id} className="fix-check">
              <span className="name">{check.name}</span>
              <span className="badge badge-bad">{t('state.failed')}</span>
            </li>
          ))}
        </ul>
        {allowed.length > 0 && <p className="muted small">{t('fix.allowed', { count: allowed.length })}</p>}
        <p className="muted small">{used > 0 ? t('fix.attemptsUsed', { count: used }) : t('fix.attemptsFresh')}</p>
      </div>
    </Dialog>
  );
}

/** The fix under way or waiting for its push: live only while an agent works on it. */
function FixState({ pr, onPush, pushing }: { pr: WorkItemPullRequest; onPush: () => void; pushing: boolean }) {
  const { t } = useTranslation('checks');
  const stage = fixStage(pr);
  if (!stage) return null;
  const facts = [pr.fixOrigin ? t(`fix.origin.${pr.fixOrigin}`) : null, pr.fixAttempts ? t('fix.attempt', { count: pr.fixAttempts }) : null].filter((part): part is string => !!part).join(' · ');
  return (
    <div className={`check-fix ${stage === 'push' ? '' : 'live-rail'}`.trim()} role="status" aria-label={t('fix.label')}>
      {stage === 'push' ? <span className="badge badge-idle">{t('fix.waiting')}</span> : <Spinner />}
      <span className="check-fix-text">
        <b>{t(`fix.stage.${stage}`)}</b> <span className="check-fix-facts">{facts}</span>
        <br />
        <span>{t(`fix.hint.${stage === 'push' ? 'push' : pr.fixOrigin === 'decision' ? 'decision' : 'person'}`)}</span>
      </span>
      {stage === 'push' && (
        <button type="button" className="btn btn-primary btn-small workitem-push-fix" disabled={pushing} onClick={onPush}>
          <Send {...ICON_SM} />
          {t('fix.push')}
        </button>
      )}
    </div>
  );
}

/**
 * The checks of the item's open change request, under its row: the list grouped failing, running,
 * passed and skipped, each row with its colour and its word, and a log tail on a row's press (a
 * panel under the list, a sheet on a phone). The section's actions are offered only when they can
 * do something, and "Fix failing checks" is its one gradient action. Reference: DesktopTareaChecks,
 * MobileTareaChecks and their states.
 */
export function Checks({ pr, itemId }: { pr: WorkItemPullRequest | null | undefined; itemId: string }) {
  const { t } = useTranslation('checks');
  const words = useChangeRequestWords(pr?.host);
  const narrow = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useChangeRequestChecks(pr);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const id = pr?.phase === 'open' ? pr.id : undefined;
  const checks = list.data?.checks ?? [];
  const now = useRunningClock(checks.some((c) => c.state === 'running'));

  const settle = () => {
    void qc.invalidateQueries({ queryKey: keys.workItem(itemId) });
    if (id) void qc.invalidateQueries({ queryKey: keys.changeRequest(id) });
  };
  const written = (result: ChangeRequestChecks) => {
    if (id) qc.setQueryData(keys.changeRequestChecks(id), result);
    settle();
  };
  const failed = (title: string) => (error: unknown) => {
    toast.error(title, error);
    settle();
  };
  const rerun = useMutation({
    mutationFn: (req: Parameters<typeof api.rerunChecks>[1]) => api.rerunChecks(id ?? '', req),
    onSuccess: written,
    onError: failed(t('errors.rerun')),
  });
  const cancel = useMutation({ mutationFn: () => api.cancelChecks(id ?? ''), onSuccess: written, onError: failed(t('errors.cancel')) });
  const play = useMutation({ mutationFn: (checkId: string) => api.runCheck(id ?? '', checkId), onSuccess: written, onError: failed(t('errors.run')) });
  const refresh = useMutation({ mutationFn: () => api.changeRequestChecks(id ?? '', true), onSuccess: written, onError: failed(t('errors.refresh')) });
  const fix = useMutation({
    mutationFn: () => api.fixChecks(id ?? ''),
    onSuccess: (result) => {
      setFixing(false);
      settle();
      // A project whose flow is off gets the prompt as a chat of its own, in the item's worktree
      if (!result.started) navigate(result.worktree ? `/chats/new?cwd=${encodeURIComponent(result.worktree)}` : '/chats/new', { state: { prompt: result.prompt } });
    },
    onError: failed(t('errors.fix')),
  });
  const push = useMutation({ mutationFn: () => api.pushFix(id ?? ''), onSuccess: settle, onError: failed(t('errors.push')) });

  if (!pr || !id) return null;

  const rollup = list.data?.rollup ?? pr.ci ?? 'none';
  const groups = groupChecks(checks);
  const counts = countChecks(checks);
  const actions = checksActions(list.data, pr);
  const open = checks.find((c) => c.id === openId) ?? null;
  const busy = rerun.isPending || cancel.isPending || play.isPending || refresh.isPending;
  const host = words.host;
  const sum = [
    counts.failed + counts.allowed > 0 ? t('sum.failed', { count: counts.failed + counts.allowed }) : null,
    counts.running > 0 ? t('sum.running', { count: counts.running }) : null,
    counts.passed > 0 ? t('sum.passed', { count: counts.passed }) : null,
    counts.skipped > 0 ? t('sum.skipped', { count: counts.skipped }) : null,
  ]
    .filter((part): part is string => !!part)
    .join(' · ');
  const limitedUntil = list.data?.limitedUntil ?? null;

  const rowEntries = (check: Check): MenuEntry[] => [
    isManual(check)
      ? { id: 'run', label: t('menu.run'), icon: Play, disabled: busy, onSelect: () => play.mutate(check.id) }
      : {
          id: 'rerun',
          label: t('menu.rerun'),
          icon: RefreshCw,
          disabled: busy || !check.rerunnable,
          disabledReason: check.rerunnable ? undefined : t('menu.notRerunnable', { host }),
          onSelect: () => rerun.mutate({ scope: 'check', checkId: check.id }),
        },
    ...(check.url ? [{ id: 'open', label: t('openOn', { host }), icon: ExternalLink, onSelect: () => void window.open(check.url ?? '', '_blank', 'noopener,noreferrer') }] : []),
  ];
  const headEntries: MenuEntry[] = [
    { id: 'refresh', label: t('menu.refresh'), icon: RefreshCw, disabled: busy, onSelect: () => refresh.mutate() },
    ...(actions.rerunAll ? [{ id: 'rerun-all', label: t('actions.rerunAll'), icon: RefreshCw, disabled: busy, onSelect: () => rerun.mutate({ scope: 'all' }) }] : []),
    ...(pr.url ? [{ id: 'open', label: t('openOn', { host }), icon: ExternalLink, onSelect: () => void window.open(pr.url ?? '', '_blank', 'noopener,noreferrer') }] : []),
  ];
  const toggle = (check: Check) => setOpenId((current) => (current === check.id ? null : check.id));

  return (
    <section className="checks" aria-label={t('title')}>
      <div className="checks-head">
        <div className="checks-title">
          <h2>{t('title')}</h2>
          <span className="checks-sum">{sum}</span>
        </div>
        {checks.length === 0 && <CiBadge ci={rollup} />}
        <span className="grow" />
        <div className="checks-actions">
          {actions.rerunFailed && (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => rerun.mutate({ scope: 'failed' })}>
              <RefreshCw {...ICON_SM} />
              {t('actions.rerunFailed')}
            </button>
          )}
          {actions.cancel && (
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => cancel.mutate()}>
              <SquareX {...ICON_SM} />
              {t('actions.cancel')}
            </button>
          )}
          {actions.fix && (
            <button type="button" className="btn btn-primary btn-small workitem-fix-checks" disabled={fix.isPending || !!limitedUntil} onClick={() => setFixing(true)}>
              <Sparkles {...ICON_SM} />
              {t('actions.fix')}
            </button>
          )}
        </div>
        <MoreActions label={t('actions.more')} entries={headEntries} />
      </div>

      <FixState pr={pr} pushing={push.isPending} onPush={() => push.mutate()} />

      {limitedUntil && (
        <div className="check-limit" role="note">
          <CircleAlert {...ICON_SM} />
          <div className="col">
            <span>
              <span className="badge badge-warn">{t('limited.badge')}</span>
            </span>
            <span>{t('limited.body', { host, time: formatHour(limitedUntil) })}</span>
            {list.data && <span className="check-asof">{t('limited.asOf', { time: formatHour(list.data.checkedAt) })}</span>}
          </div>
        </div>
      )}

      <div className="checks-card">
        {list.isPending ? (
          <div className="check-quiet" role="status">
            <span className="spinner" aria-hidden />
            <span>{t('loading')}</span>
          </div>
        ) : list.error ? (
          <div className="check-quiet warn" role="note">
            <CircleAlert {...ICON_SM} />
            <div className="check-quiet-text">
              <span>{t('failed', { host })}</span>
              <button type="button" className="btn btn-small" onClick={() => void list.refetch()}>
                {t('retry')}
              </button>
            </div>
          </div>
        ) : checks.length === 0 ? (
          <div className="check-quiet" role="note">
            <Minus {...ICON_SM} />
            <div className="check-quiet-text">
              <span>{t('none.title', { noun: words.noun })}</span>
              <span className="check-hint">{t('none.hint', { host })}</span>
            </div>
          </div>
        ) : (
          <>
            <CheckList groups={groups} now={now} openId={openId} rowEntries={rowEntries} onOpen={toggle} />
            {list.data?.truncated && <div className="check-quiet">{t('truncated')}</div>}
            {!narrow && open && <CheckLogPanel changeRequestId={id} check={open} hostLabel={host} now={now} onClose={() => setOpenId(null)} />}
          </>
        )}
      </div>

      {narrow && open && (
        <Sheet open onOpenChange={(next) => !next && setOpenId(null)} side="bottom" title={t('log.of', { name: open.name })} description={checkFacts(open, now)} closeLabel={t('log.close')}>
          <div className="check-log is-sheet">
            <div className="check-log-head">
              <span className={markBadge(checkMark(open).tone)}>{t(checkMark(open).label)}</span>
            </div>
            <CheckLogBody changeRequestId={id} check={open} />
            {open.url && (
              <div className="check-sheet-foot">
                <a className="btn btn-block" href={open.url} target="_blank" rel="noreferrer">
                  <ExternalLink {...ICON_SM} />
                  {t('openOn', { host })}
                </a>
              </div>
            )}
          </div>
        </Sheet>
      )}

      {fixing && list.data && <FixDialog list={list.data} pr={pr} busy={fix.isPending} onStart={() => fix.mutate()} onClose={() => setFixing(false)} />}
    </section>
  );
}
