import type { CheckAnnotation, Check, ChangeRequestChecks, Orchestration, OrchestrationPullRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, GitBranch, Play, RotateCw, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../api';
import { MoreActions, Sheet, type MenuEntry } from '@agentry/ui/components/controls';
import { useConfirm } from '@agentry/ui/components/Dialog';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { formatDateTime } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { useClockTick } from '@agentry/ui/lib/motion';
import { checkDurationMs, checkMark, checksActions, clockOf, countChecks, groupChecks, isManual, type CheckGroupId, type CheckTone } from '../lib/change-requests';
import { isErrorLine, orchestrationFix } from '../lib/orchestration-v2';

type Words = { noun: string; host: string; ref: (number: number | null, ref?: string | null) => string };

const TONE_CLASS: Record<CheckTone, string> = { ok: 'badge-ok', warn: 'badge-warn', bad: 'badge-bad', idle: 'badge-idle', live: 'badge-active' };

/** A row's word and colour. Only a running check carries the live tone and the ring spinner. */
function StateBadge({ check }: { check: Check }) {
  const { t } = useTranslation('orchestrationV2');
  const mark = checkMark(check);
  return (
    <span className={`badge ${TONE_CLASS[mark.tone]}`}>
      {mark.tone === 'live' && <span className="spinner-xs" aria-hidden />}
      {t(`checks.${mark.label}` as 'checks.state.failed')}
    </span>
  );
}

/** The mono clock of a row; a running one counts, and only it subscribes to the tick. */
function Clock({ check }: { check: Check }) {
  useClockTick(check.state === 'running' ? 1000 : 60_000);
  const ms = checkDurationMs(check, Date.now());
  return <span className="ochk-dur">{ms === null ? '' : clockOf(ms)}</span>;
}

function Annotations({ items }: { items: CheckAnnotation[] }) {
  return (
    <dl>
      {items.map((a, i) => (
        <div key={i} className="ochk-note">
          <dt>{a.path ? `${a.path}${a.startLine ? `:${a.startLine}` : ''}` : a.level}</dt>
          <dd>{[a.title, a.message].filter(Boolean).join(' · ')}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The tail of one check's log, with what the check says about the run above it. */
function CheckLogPanel({ crId, check, words, sheet }: { crId: string; check: Check; words: Words; sheet: boolean }) {
  const { t } = useTranslation('orchestrationV2');
  const log = useQuery({
    queryKey: keys.checkLog(crId, check.id),
    queryFn: ({ signal }) => api.checkLog(crId, check.id, { signal }),
    enabled: check.hasLog,
  });
  const data = log.data;
  const lines = data?.lines ?? [];
  return (
    <section className="ochk-log" aria-label={t('checks.log.panel', { name: check.name })}>
      {!sheet && (
        <div className="ochk-log-head">
          <span className="mono ochk-log-name">{check.name}</span>
          <StateBadge check={check} />
          <span className="mono small muted">{t('checks.log.job', { id: check.id })}</span>
          <span className="grow" />
          {check.url && (
            <a className="btn btn-small" href={check.url} target="_blank" rel="noreferrer">
              <ExternalLink {...ICON_SM} /> {t('checks.row.openOnHost', { host: words.host })}
            </a>
          )}
        </div>
      )}
      {data && data.annotations.length > 0 && (
        <div className="ochk-why">
          <span className="section-label">{t('checks.log.why')}</span>
          <Annotations items={data.annotations} />
        </div>
      )}
      {!check.hasLog || log.isError ? (
        <p className="ochk-tail-note">{t('checks.log.unavailable')}</p>
      ) : log.isPending ? (
        <p className="ochk-tail-note">{t('checks.log.loading')}</p>
      ) : data?.noOutputYet || lines.length === 0 ? (
        <p className="ochk-tail-note">{t('checks.log.noOutput')}</p>
      ) : (
        <>
          <p className="ochk-tail-note">{t(data?.truncated ? 'checks.log.tailTruncated' : 'checks.log.tail', { count: lines.length })}</p>
          <pre className="ochk-tail" aria-label={t('checks.log.tailLabel', { name: check.name })}>
            {lines.map((line, i) => (
              <span key={i} className={isErrorLine(line) ? 'mark' : undefined}>
                {line}
              </span>
            ))}
          </pre>
        </>
      )}
    </section>
  );
}

function CheckRow({
  check,
  selected,
  words,
  busy,
  onOpen,
  onRerun,
  onRun,
}: {
  check: Check;
  selected: boolean;
  words: Words;
  busy: boolean;
  onOpen: () => void;
  onRerun: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation('orchestrationV2');
  const entries: MenuEntry[] = [];
  if (isManual(check)) entries.push({ id: 'run', label: t('checks.row.run'), icon: Play, onSelect: onRun, disabled: busy });
  else if (check.rerunnable) entries.push({ id: 'rerun', label: t('checks.row.rerun'), icon: RotateCw, onSelect: onRerun, disabled: busy });
  if (check.url) entries.push({ id: 'host', label: t('checks.row.openOnHost', { host: words.host }), icon: ExternalLink, href: check.url });
  return (
    <div className={`ochk-row${selected ? ' on' : ''}`}>
      <button type="button" className="ochk-main" aria-label={t('checks.row.open', { name: check.name })} aria-pressed={selected} onClick={onOpen}>
        <span className="ochk-state">
          <StateBadge check={check} />
        </span>
        <span className="ochk-name">{check.name}</span>
        <span className="ochk-stage">{check.group ?? ''}</span>
        <Clock check={check} />
      </button>
      {entries.length > 0 && <MoreActions entries={entries} label={t('checks.row.more', { name: check.name })} className="btn-ghost btn-icon" />}
    </div>
  );
}

/**
 * An orchestration's change request, as CI sees it: the checks of its head, grouped, with each
 * log's tail; the zone's one gradient action is **Fix failing checks**, and once a fix is
 * committed it becomes **Push the fix**, which an orchestration always leaves to the person.
 */
export function OrchestrationChecks({ orch, pr, words }: { orch: Orchestration; pr: OrchestrationPullRequest & { id: string }; words: Words }) {
  const { t } = useTranslation('orchestrationV2');
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const narrow = useMediaQuery(NARROW);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<CheckGroupId>>(new Set());

  const list = useQuery({ queryKey: keys.changeRequestChecks(pr.id), queryFn: ({ signal }) => api.changeRequestChecks(pr.id, false, { signal }) });
  const checks = list.data;
  const keep = (next: ChangeRequestChecks) => queryClient.setQueryData(keys.changeRequestChecks(pr.id), next);
  const refreshOrch = () => queryClient.invalidateQueries({ queryKey: keys.orchestration(orch.id) });

  const rerun = useMutation({ mutationFn: (req: Parameters<typeof api.rerunChecks>[1]) => api.rerunChecks(pr.id, req), onSuccess: keep });
  const cancel = useMutation({ mutationFn: () => api.cancelChecks(pr.id), onSuccess: keep });
  const run = useMutation({ mutationFn: (checkId: string) => api.runCheck(pr.id, checkId), onSuccess: keep });
  const fix = useMutation({
    mutationFn: () => api.fixChecks(pr.id),
    onSuccess: (res) => {
      if (res.started) toast.success(t('checks.fixStarted'));
      else toast.info(t('checks.fixPrompt'), res.prompt);
      void refreshOrch();
    },
  });
  const push = useMutation({
    mutationFn: () => api.pushFix(pr.id),
    onSuccess: () => {
      toast.success(t('checks.push.pushed'));
      void refreshOrch();
      void queryClient.invalidateQueries({ queryKey: keys.changeRequestChecks(pr.id) });
    },
  });

  const stage = orchestrationFix(pr);
  const actions = checksActions(checks, { fixState: pr.fixState ?? null });
  const counts = countChecks(checks?.checks ?? []);
  const groups = groupChecks(checks?.checks ?? []);
  const open = checks?.checks.find((c) => c.id === selected) ?? null;
  const busy = rerun.isPending || cancel.isPending || run.isPending;
  const sha = (pr.fixHead ?? checks?.headSha ?? '').slice(0, 7);

  const summary = [
    counts.failed && t('checks.summary.failed', { count: counts.failed }),
    counts.allowed && t('checks.summary.allowed', { count: counts.allowed }),
    counts.running && t('checks.summary.running', { count: counts.running }),
    counts.passed && t('checks.summary.passed', { count: counts.passed }),
    counts.skipped && t('checks.summary.skipped', { count: counts.skipped }),
  ].filter(Boolean);

  const toggle = (id: CheckGroupId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Passed and skipped checks fold away until asked for; the ones that need a person never do
  const isFolded = (id: CheckGroupId) => (id === 'passed' || id === 'skipped' ? !expanded.has(id) : false);

  const pushFix = () =>
    void confirm({
      title: t('checks.push.confirmTitle', { branch: pr.branch }),
      body: t('checks.push.confirmBody', { noun: words.noun }),
      confirmLabel: t('checks.push.confirmLabel'),
    }).then((ok) => {
      if (ok) push.mutate();
    });

  return (
    <div className="ochk">
      {stage === 'push' && (
        <section className="ochk-fix grad-border" aria-label={t('checks.push.title')}>
          <div className="ochk-line">
            <h3 className="ochk-h grow">{t('checks.push.title')}</h3>
            <span className="badge badge-idle">{t('checks.push.waiting')}</span>
          </div>
          <p className="small muted">{t('checks.push.body')}</p>
          <div className="ochk-fix-facts">
            <span>
              <GitBranch {...ICON_SM} /> {t('checks.push.facts', { branch: pr.branch })}
            </span>
          </div>
          <div className="ochk-line ochk-fix-foot">
            <span className="muted small grow">{t('checks.push.head', { noun: words.noun, ref: words.ref(pr.number, pr.ref), sha })}</span>
            <button type="button" className="btn btn-primary" disabled={push.isPending} onClick={pushFix}>
              <GitBranch {...ICON_SM} /> {push.isPending ? t('checks.push.pushing') : t('checks.push.button')}
            </button>
          </div>
        </section>
      )}

      <div className="ochk-line ochk-head">
        <h3 className="ochk-h grow">{t('checks.title')}</h3>
        {summary.length > 0 && <span className="mono small muted ochk-summary">{summary.join(' · ')}</span>}
      </div>

      {(actions.rerunFailed || actions.cancel || actions.fix) && (
        <div className="ochk-line ochk-actions">
          {actions.rerunFailed && (
            <button type="button" className="btn" disabled={busy} onClick={() => rerun.mutate({ scope: 'failed' })}>
              <RotateCw {...ICON_SM} /> {t('checks.rerunFailed')}
            </button>
          )}
          {actions.cancel && (
            <button type="button" className="btn" disabled={busy} onClick={() => cancel.mutate()}>
              <X {...ICON_SM} /> {t('checks.cancel')}
            </button>
          )}
          <span className="grow" />
          {actions.fix && (
            <button type="button" className="btn btn-primary" disabled={fix.isPending} onClick={() => fix.mutate()}>
              <Sparkles {...ICON_SM} /> {t('checks.fix')}
            </button>
          )}
        </div>
      )}
      {actions.fix && <p className="small muted">{t('checks.fixHint', { branch: pr.branch })}</p>}
      {stage === 'fixing' && (
        <p className="small ochk-fixing">
          <span className="spinner-ring" aria-hidden /> {t('checks.fixing')}
        </p>
      )}
      {checks?.limitedUntil && <div className="alert alert-warn small">{t('checks.limited', { time: formatDateTime(checks.limitedUntil) })}</div>}
      {list.isError && <div className="alert alert-warn small">{t('checks.unavailable')}</div>}
      {checks && checks.checks.length === 0 && <p className="small muted">{t('checks.none')}</p>}

      {groups.length > 0 && (
        <div className={`ochk-body${open && !narrow ? ' with-log' : ''}`}>
          <div className="ochk-list">
            {groups.flatMap((group) => {
              const rows = (list: Check[]) =>
                list.map((check) => (
                  <CheckRow
                    key={check.id}
                    check={check}
                    selected={open?.id === check.id}
                    words={words}
                    busy={busy}
                    onOpen={() => setSelected(check.id)}
                    onRerun={() => rerun.mutate({ scope: 'check', checkId: check.id })}
                    onRun={() => run.mutate(check.id)}
                  />
                ));
              if (isFolded(group.id)) {
                return [
                  <button key={group.id} type="button" className="ochk-fold btn btn-ghost" aria-expanded={false} onClick={() => toggle(group.id)}>
                    <ChevronRight {...ICON_SM} /> {t(`checks.groups.${group.id}`)} <span className="count">{group.checks.length}</span>
                  </button>,
                ];
              }
              const failedRows = group.checks.filter((c) => !(c.state === 'failed' && c.allowedToFail));
              const allowedRows = group.checks.filter((c) => c.state === 'failed' && c.allowedToFail);
              const sections: Array<{ key: string; label: string; list: Check[] }> =
                group.id === 'failed'
                  ? [
                      { key: 'failed', label: t('checks.groups.failed'), list: failedRows },
                      { key: 'allowed', label: t('checks.groups.allowed'), list: allowedRows },
                    ]
                  : [{ key: group.id, label: t(`checks.groups.${group.id}`), list: group.checks }];
              return sections
                .filter((s) => s.list.length > 0)
                .map((s) => (
                  <div key={s.key} className="ochk-group">
                    <div className="ochk-group-head">
                      {group.id === 'passed' || group.id === 'skipped' ? (
                        <button type="button" className="ochk-fold btn btn-ghost" aria-expanded onClick={() => toggle(group.id)}>
                          <ChevronRight {...ICON_SM} className="ochk-open" /> {s.label} <span className="count">{s.list.length}</span>
                        </button>
                      ) : (
                        <>
                          <span className="section-label">{s.label}</span>
                          <span className="count">{s.list.length}</span>
                        </>
                      )}
                    </div>
                    {rows(s.list)}
                  </div>
                ));
            })}
          </div>
          {open && !narrow && <CheckLogPanel crId={pr.id} check={open} words={words} sheet={false} />}
        </div>
      )}

      {open && narrow && (
        <Sheet open onOpenChange={(next) => !next && setSelected(null)} title={open.name} className="ochk-sheet">
          <div className="ochk-line ochk-sheet-head">
            <StateBadge check={open} />
            <span className="mono small muted">{t('checks.log.job', { id: open.id })}</span>
          </div>
          <CheckLogPanel crId={pr.id} check={open} words={words} sheet />
          {open.url && (
            <a className="btn" href={open.url} target="_blank" rel="noreferrer">
              <ExternalLink {...ICON_SM} /> {t('checks.row.openOnHost', { host: words.host })}
            </a>
          )}
        </Sheet>
      )}
    </div>
  );
}
