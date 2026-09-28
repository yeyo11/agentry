import type { Chat, ChangeSummary, EditStep, Orchestration, OrchestrationTaskState, TouchedFile } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { baseName, liveFile, reviewLink, reviewPath, statusLetter, stepFiles, workFiles } from '../../lib/changes-summary';
import { formatDateTime, timeAgo } from '../../lib/format';
import type { TickerActivity } from '../../lib/live';
import { totalsOf } from '../../lib/observe';
import { Fingerprint } from '../changes/Fingerprint';
import { ICON_SM } from '../icons';
import { Spinner } from '../Spinner';
import { ErrorBox, Loading } from '../ui';

/*
 * The compact summary of what a chat, a task or the integration branch changed: the totals, the
 * files as one line each, the latest step and the way into the review screen. Reading a diff
 * happens there, never here, so nothing opens on top of the inspector's sheet on a phone.
 */

const LIVE_REFRESH_MS = 8_000;
/** Past this the list says how many more there are; the review screen has them all */
const FILE_ROWS = 12;

const signed = (n: number, sign: '+' | '−') => `${sign}${n}`;

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  const { t } = useTranslation('observe');
  return (
    <span className="obs-counts mono small">
      {/* The signs and the numbers say it; the screen reader gets it as a sentence */}
      <span className="sr-only">{t('changes.counts', { additions, deletions })}</span>
      {additions > 0 && (
        <span aria-hidden className="obs-add">
          {signed(additions, '+')}
        </span>
      )}
      {additions > 0 && deletions > 0 && ' '}
      {deletions > 0 && (
        <span aria-hidden className="obs-del">
          {signed(deletions, '−')}
        </span>
      )}
    </span>
  );
}

interface Row {
  path: string;
  letter: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  uncommitted: boolean;
}

function FileRows({ rows, live, to, more, label }: { rows: Row[]; live: string | null; to: (path: string) => string; more: number; label: string }) {
  const { t } = useTranslation('observe');
  return (
    <ul className="obs-files obs-changes-files" aria-label={label}>
      {rows.map((row) => (
        <li key={row.path} className="obs-file">
          <Link to={to(row.path)} className={`obs-file-row ${row.path === live ? 'live-rail is-live' : ''}`.trim()} title={row.path}>
            <span className={`obs-status is-${row.letter ?? 'none'} mono`} aria-hidden>
              {row.letter}
            </span>
            <span className="sr-only">{row.status}</span>
            <span className="obs-file-what">
              <span className="obs-file-name mono">{baseName(row.path)}</span>
              {row.uncommitted && (
                <span className="obs-uncommitted" title={t('changes.uncommitted')}>
                  <span className="sr-only">{t('changes.uncommitted')}</span>
                </span>
              )}
            </span>
            <span className="obs-file-end">
              {row.path === live && (
                <>
                  <Spinner />
                  <span className="sr-only">{t('changes.editingNow')}</span>
                </>
              )}
              {row.additions !== null && row.deletions !== null && <Counts additions={row.additions} deletions={row.deletions} />}
            </span>
          </Link>
        </li>
      ))}
      {more > 0 && <li className="obs-files-more small muted">{t('changes.more', { count: more })}</li>}
    </ul>
  );
}

function LatestStep({ step, to }: { step: EditStep; to: string }) {
  const { t } = useTranslation('observe');
  return (
    <section className="obs-changes-part">
      <h3 className="section-label">{t('changes.latestStep')}</h3>
      <Link to={to} className="obs-step-card">
        <span className="obs-step-line">
          {step.pending && <Spinner />}
          <span className="mono muted obs-step-time" title={step.at ? formatDateTime(step.at) : undefined}>
            {step.pending ? t('changes.now') : step.at ? timeAgo(step.at) : ''}
          </span>
          <span className="badge">{step.tool}</span>
          <span className="mono ellipsis obs-step-file" title={step.path}>
            {baseName(step.path)}
          </span>
        </span>
        {step.intent && <span className="obs-step-intent">{t('changes.intent', { text: step.intent })}</span>}
      </Link>
    </section>
  );
}

function StepsLink({ count, to, primary }: { count: number; to: string; primary: boolean }) {
  const { t } = useTranslation('observe');
  if (primary) {
    return (
      <Link to={to} className="btn btn-primary btn-block changes-review-link">
        {t('changes.reviewSteps', { count })}
        <ArrowRight {...ICON_SM} />
      </Link>
    );
  }
  return (
    <Link to={to} className="btn btn-small btn-block obs-changes-steps">
      {t('changes.seeSteps', { count })}
    </Link>
  );
}

export interface ChangesSummaryProps {
  /** Null when the source is no git checkout: then the steps are all there is */
  summary: ChangeSummary | null;
  /** Null when the source keeps no transcript, or it is not read yet */
  steps: EditStep[] | null;
  /** The files the transcript says were written, for a chat outside git whose steps are unknown */
  touched?: TouchedFile[];
  /** What the agent is doing right now, when it is working */
  activity?: TickerActivity | null;
  /** The review screen of this source */
  base: string;
  title?: string;
}

/** The totals, the files, the latest step and the way into the review. */
export function ChangesSummary({ summary, steps, touched = [], activity = null, base, title }: ChangesSummaryProps) {
  const { t } = useTranslation('observe');
  const heading = title ?? t('changes.title');
  const latest = steps?.at(-1) ?? null;
  const stepsTo = reviewLink(base, { lens: 'steps' });

  if (!summary) {
    // No git: the transcript's edits are the record, so the review opens on Step by step
    const files = steps && steps.length > 0 ? stepFiles(steps) : null;
    const rows: Row[] = files
      ? files.map((f) => ({ path: f.path, letter: f.created ? 'A' : 'M', status: t(`changes.status.${f.created ? 'added' : 'modified'}`), additions: f.additions, deletions: f.deletions, uncommitted: false }))
      : touched.map((f) => ({ path: f.path, letter: null, status: f.tool, additions: null, deletions: null, uncommitted: false }));
    const totals = files ? files.reduce((sum, f) => ({ additions: sum.additions + f.additions, deletions: sum.deletions + f.deletions }), { additions: 0, deletions: 0 }) : null;
    const live = liveFile(activity, rows.map((r) => r.path));
    return (
      <section className="obs-changes">
        <div className="obs-changes-head">
          <h3 className="section-label">{heading}</h3>
          {totals && <Counts {...totals} />}
        </div>
        <p className="small muted">{t('changes.stepsOnly')}</p>
        {rows.length === 0 ? (
          <p className="small muted">{t('changes.nothingTouched')}</p>
        ) : (
          <FileRows rows={rows.slice(0, FILE_ROWS)} more={rows.length - FILE_ROWS} live={live} label={t('changes.files')} to={() => stepsTo} />
        )}
        {latest && <LatestStep step={latest} to={reviewLink(base, { lens: 'steps', step: latest.id })} />}
        {steps && steps.length > 0 && <StepsLink count={steps.length} to={stepsTo} primary />}
      </section>
    );
  }

  const files = workFiles(summary);
  const uncommitted = new Set(summary.uncommitted.map((f) => f.path));
  const totals = totalsOf(files);
  const live = liveFile(activity, files.map((f) => f.path));
  const to = (path: string) => reviewLink(base, { file: path });
  const rows: Row[] = files.map((f) => ({
    path: f.path,
    letter: statusLetter(f),
    status: t(`changes.status.${f.binary ? 'binary' : f.status}`),
    additions: f.additions,
    deletions: f.deletions,
    uncommitted: uncommitted.has(f.path),
  }));
  return (
    <section className="obs-changes">
      <div className="obs-changes-head">
        <h3 className="section-label">{heading}</h3>
        {files.length > 0 && <Counts {...totals} />}
      </div>
      <p className="obs-changes-meta mono small">
        {[summary.branch ?? t('changes.detached'), t('changes.commitCount', { count: summary.ahead }), t('changes.fileCount', { count: files.length })].join(' · ')}
      </p>
      {files.length === 0 ? (
        <p className="small muted">{t('changes.nothing')}</p>
      ) : (
        <>
          <Fingerprint files={files} to={to} />
          <FileRows rows={rows.slice(0, FILE_ROWS)} more={rows.length - FILE_ROWS} live={live} label={t('changes.files')} to={to} />
        </>
      )}
      {latest && <LatestStep step={latest} to={reviewLink(base, { lens: 'steps', step: latest.id })} />}
      {(files.length > 0 || (steps?.length ?? 0) > 0) && (
        <div className="obs-changes-actions">
          <Link to={base} className="btn btn-primary btn-block changes-review-link">
            {t('changes.review')}
            <ArrowRight {...ICON_SM} />
          </Link>
          {steps && steps.length > 0 && <StepsLink count={steps.length} to={stepsTo} primary={false} />}
        </div>
      )}
    </section>
  );
}

// ---------- the three sources ----------

/** A chat: its git summary when it works in a checkout, and the steps of its transcript. */
export function ChatChangesSummary({ chat }: { chat: Chat }) {
  const live = Boolean(chat.execution);
  const interval = live ? LIVE_REFRESH_MS : false;
  const changes = useQuery({ queryKey: keys.chatChanges(chat.id), queryFn: () => api.chatChanges(chat.id), refetchInterval: interval });
  const steps = useQuery({ queryKey: keys.chatSteps(chat.id), queryFn: () => api.chatSteps(chat.id), refetchInterval: interval });
  if (changes.isLoading) return <Loading />;
  if (changes.error) return <ErrorBox error={changes.error} />;
  if (!changes.data) return null;
  return (
    <ChangesSummary
      summary={changes.data.summary}
      steps={steps.data ?? null}
      touched={changes.data.touched}
      activity={live ? chat.activity : null}
      base={reviewPath.chat(chat.id)}
    />
  );
}

/** A task of an orchestration: its branch against the graph's base, and its worker's steps. */
export function TaskChangesSummary({ orch, task }: { orch: Orchestration; task: OrchestrationTaskState }) {
  const { t } = useTranslation('observe');
  const live = task.status === 'running';
  const interval = live ? LIVE_REFRESH_MS : false;
  const hasBranch = Boolean(orch.worktree && task.branch);
  const changes = useQuery({
    queryKey: keys.taskChanges(orch.id, task.id),
    queryFn: () => api.taskChanges(orch.id, task.id),
    refetchInterval: interval,
    enabled: hasBranch,
  });
  const steps = useQuery({ queryKey: keys.taskSteps(orch.id, task.id), queryFn: () => api.taskSteps(orch.id, task.id), refetchInterval: interval });
  const base = reviewPath.task(orch.id, task.id);
  if (!hasBranch) {
    return (
      <div className="stack-tight">
        <p className="muted small">{t('changes.noWorktree')}</p>
        {steps.data && steps.data.length > 0 && <ChangesSummary summary={null} steps={steps.data} activity={live ? task.activity : null} base={base} />}
      </div>
    );
  }
  if (changes.isLoading) return <Loading />;
  if (changes.error) return <ErrorBox error={changes.error} />;
  if (!changes.data) return null;
  return <ChangesSummary summary={changes.data} steps={steps.data ?? null} activity={live ? task.activity : null} base={base} />;
}

/** The branch that merges every task's work. It has no transcript of its own, so no steps. */
export function IntegrationChangesSummary({ orch, title }: { orch: Orchestration; title?: string }) {
  const integration = orch.integration;
  const live = integration?.status === 'merging' || integration?.status === 'resolving';
  const changes = useQuery({
    queryKey: keys.integrationChanges(orch.id),
    queryFn: () => api.integrationChanges(orch.id),
    refetchInterval: live ? LIVE_REFRESH_MS : false,
    enabled: Boolean(integration),
  });
  if (!integration) return null;
  if (changes.isLoading) return <Loading />;
  if (changes.error) return <ErrorBox error={changes.error} />;
  if (!changes.data) return null;
  return <ChangesSummary summary={changes.data} steps={null} base={reviewPath.integration(orch.id)} title={title} />;
}
