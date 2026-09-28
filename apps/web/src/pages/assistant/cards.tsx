import type { AssistantRun, AssistantRunDetail, Project } from '@agentry/shared';
import { CircleAlert, CircleX, Info, Sparkle } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AssistantMark, LiveRunHead, RunFacts, RunFindings, RunSources, SuggestionWait } from '../../components/assistant/run';
import { ICON, ICON_SM } from '../../components/icons';
import { Empty, ErrorBox } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { localized } from '../../lib/server-strings';
import { proposalsOf, readSummary, tally } from './model';
import { MemberProposalRow, ResourceProposalRow, SectionHead, useDecide, WorkItemProposalRow } from './proposals';
import type { RunActions } from './view';

/* The parts both the desktop and the phone layouts of the assistant page draw. */

/** A project the assistant never read: what it would do, and the one button that starts it. */
export function NoRun({ project, actions }: { project: Project; actions: RunActions }) {
  const { t } = useTranslation('assistant');
  return (
    <section className="card glow-top assistant-none">
      <Empty
        illustration="team"
        size="md"
        title={t('none.title')}
        action={
          <button type="button" className="btn btn-primary" disabled={actions.start.isPending} onClick={() => actions.start.mutate({ kind: 'project' })}>
            <Sparkle {...ICON_SM} />
            {t('none.start')}
          </button>
        }
      >
        {t('none.body')}
      </Empty>
      <ErrorBox error={actions.start.error} />
      <span className="sr-only">{project.name}</span>
    </section>
  );
}

/** "14 proposals after reading 61 files, 23 chats and docs/". */
function useReadLine(run: AssistantRun, phone: boolean): { count: string; after: string } {
  const { t } = useTranslation('assistant');
  const summary = readSummary(run.sources);
  const parts = [
    ...(summary.files > 0 ? [t('done.files', { count: summary.files, n: formatNumber(summary.files) })] : []),
    ...(summary.chats > 0 ? [t('done.chats', { count: summary.chats, n: formatNumber(summary.chats) })] : []),
    ...(phone ? [] : summary.dirs),
  ];
  const what = parts.length === 0 ? t('done.nothingRead') : parts.length === 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} ${t('done.and')} ${parts[parts.length - 1] ?? ''}`;
  const total = Object.values(run.counts).reduce((sum, c) => sum + c.total - c.superseded, 0);
  return { count: t('done.proposals', { count: total, n: formatNumber(total) }), after: t(phone ? 'done.afterPhone' : 'done.after', { what }) };
}

/** A finished run folded into one still line, or, when it failed or was stopped, what happened. */
export function DoneLine({ run, open, onToggle, phone }: { run: AssistantRunDetail; open: boolean; onToggle?: () => void; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const line = useReadLine(run, phone);
  if (run.status === 'failed' || run.status === 'stopped') {
    const failed = run.status === 'failed';
    return (
      <section className={`suggestion-run is-done assistant-ended ${failed ? 'is-failed' : 'is-stopped'}`} aria-label={failed ? t('failed.title') : t('failed.stopped')}>
        {failed ? <CircleX {...ICON} className="text-bad" /> : <CircleAlert {...ICON} className="text-warn" />}
        <span className="small assistant-done-text">
          <b>{failed ? t('failed.title') : t('failed.stopped')}</b>{' '}
          <span className="muted">{failed && run.error ? localized(run.error) : t('failed.stoppedBody')}</span>
        </span>
        <span className="grow" />
        <RunFacts run={run} />
      </section>
    );
  }
  return (
    <section className="suggestion-run is-done" aria-label={t('done.region')}>
      <div className="assistant-done-lead">
        <AssistantMark small />
        <span className="small assistant-done-text">
          <b>{line.count}</b> <span className="muted">{line.after}</span>
        </span>
      </div>
      {!phone && <span className="grow" />}
      <RunFacts run={run} />
      {onToggle && (
        <button type="button" className="btn btn-quiet btn-small" aria-expanded={open} onClick={onToggle}>
          {open ? t('done.hideRead') : t('done.seeRead')}
        </button>
      )}
    </section>
  );
}

export function ReadPanel({ run }: { run: AssistantRun }) {
  const { t } = useTranslation('assistant');
  return (
    <section className="card assistant-read" aria-label={t('done.readTitle')}>
      <RunSources sources={run.sources} label={t('done.readTitle')} />
      <RunFindings findings={run.findings} label={t('live.found')} />
    </section>
  );
}

export function TasksCard({ run, decide, phone }: { run: AssistantRunDetail; decide: ReturnType<typeof useDecide>; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const items = proposalsOf(run, 'work-item');
  const count = tally(items);
  return (
    <section className="card grad-border assistant-card assistant-tasks" aria-label={t('section.tasks')}>
      {!phone && <SectionHead section="tasks" tally={count.total > 0 ? t('tasks.accepted', count) : t('tasks.toBacklog')} />}
      {items.length === 0 ? (
        <SuggestionWait>{t('empty.noProposals')}</SuggestionWait>
      ) : (
        <ul className="assistant-rows">
          {items.map((p) => (
            <WorkItemProposalRow key={p.id} proposal={p} decide={decide} phone={phone} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function TeamCard({ run, decide, phone, compact = false }: { run: AssistantRunDetail; decide: ReturnType<typeof useDecide>; phone: boolean; compact?: boolean }) {
  const { t } = useTranslation(['assistant', 'projects']);
  const members = proposalsOf(run, 'team-member');
  const count = tally(members);
  const template = run.template ? t(`projects:templates.${run.template}.name`) : null;
  return (
    <section className={phone ? 'card grad-border assistant-card' : 'card assistant-card'} aria-label={t('section.team')}>
      {!phone && (
        <SectionHead
          section="team"
          tally={members.length > 0 ? t('team.accepted', count) : t('empty.noProposals')}
          note={template && (run.empty ? t('team.theTemplate', { name: template }) : t('team.fromTemplate', { name: template }))}
        />
      )}
      {run.empty && !phone && (
        <div className="callout assistant-card-callout">
          <Info {...ICON} className="muted" />
          <span>{t('empty.teamNote')}</span>
        </div>
      )}
      {members.length === 0 ? (
        <SuggestionWait>{t('empty.noProposals')}</SuggestionWait>
      ) : (
        <ul className="assistant-rows">
          {members.map((p) => (
            <MemberProposalRow key={p.id} proposal={p} decide={decide} phone={phone} compact={compact} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ResourcesCard({ run, projectId, decide, phone }: { run: AssistantRunDetail; projectId: string; decide: ReturnType<typeof useDecide>; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const resources = proposalsOf(run, 'resource');
  const count = tally(resources);
  return (
    <section className={phone ? 'card grad-border assistant-card' : 'card assistant-card'} aria-label={t('section.resources')}>
      {!phone && <SectionHead section="resources" tally={resources.length > 0 ? t('resources.saved', count) : t('empty.noProposals')} note={resources.length > 0 && t('resources.reviewed')} />}
      {resources.length === 0 ? (
        <SuggestionWait>{run.empty ? t('empty.resourcesLater') : t('empty.noProposals')}</SuggestionWait>
      ) : (
        <ul className="assistant-rows">
          {resources.map((p) => (
            <ResourceProposalRow key={p.id} proposal={p} projectId={projectId} decide={decide} phone={phone} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Describe the project, and the assistant proposes its first tasks from that (an empty directory has nothing else to read). */
export function Describe({ project, following, tasksRun, actions, phone }: { project: Project; following: AssistantRun | null; tasksRun: AssistantRunDetail | null; actions: RunActions; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const [text, setText] = useState('');
  const running = following?.status === 'running';
  const decide = useDecide(tasksRun?.id ?? '');
  if (tasksRun && tasksRun.status === 'running')
    return (
      <section className="suggestion-run is-live live-energy" aria-label={t('live.region')}>
        <LiveRunHead run={tasksRun} title={t('live.title')} onStop={() => actions.stop.mutate(tasksRun.id)} stopping={actions.stop.isPending} />
        <RunFacts run={tasksRun} showSchema />
        <RunSources sources={tasksRun.sources} />
      </section>
    );
  if (tasksRun && tasksRun.status === 'completed' && proposalsOf(tasksRun, 'work-item').length > 0) return <TasksCard run={tasksRun} decide={decide} phone={phone} />;
  const submit = () => actions.start.mutate({ kind: 'work-items', description: text.trim() });
  return (
    <section className="card grad-border assistant-card" aria-label={t('section.tasks')}>
      {!phone && <SectionHead section="tasks" tally={t('tasks.toBacklog')} />}
      <div className="assistant-describe">
        <p className="small muted">{phone ? t('empty.tasksIntroPhone') : t('empty.tasksIntro')}</p>
        <textarea
          className="assistant-describe-input"
          rows={3}
          value={text}
          aria-label={t('empty.describe')}
          placeholder={phone ? t('empty.describePlaceholderPhone') : t('empty.describePlaceholder')}
          onChange={(e) => setText(e.target.value)}
        />
        {tasksRun && tasksRun.status !== 'completed' && <DoneLine run={tasksRun} open={false} phone={phone} />}
        <div className="assistant-describe-foot">
          {!phone && (
            <span className="form-hint grow">
              <Trans t={t} i18nKey="empty.proposeHint" components={{ mono: <span className="mono" /> }} />
            </span>
          )}
          <button type="button" className="btn btn-primary" disabled={!text.trim() || running || actions.start.isPending} onClick={submit}>
            <Sparkle {...ICON_SM} />
            {t('empty.propose')}
          </button>
        </div>
      </div>
      <span className="sr-only">{project.name}</span>
    </section>
  );
}

export function EmptyLine({ project, phone }: { project: Project; phone: boolean }) {
  const { t } = useTranslation(['assistant', 'suggestion']);
  return (
    <section className={`suggestion-run is-done assistant-empty-line ${phone ? 'is-phone' : ''}`.trim()} aria-label={t('empty.region')}>
      <AssistantMark small />
      {phone ? (
        <span className="assistant-done-text">
          <b>{t('empty.titlePhone')}</b>
          <span className="muted">
            <Trans t={t} i18nKey="empty.bodyPhone" values={{ path: project.path }} components={{ mono: <span className="mono" /> }} />
          </span>
        </span>
      ) : (
        <>
          <span className="small assistant-done-text">
            <b>{t('empty.title')}</b>{' '}
            <span className="muted">
              <Trans t={t} i18nKey="empty.body" values={{ path: project.path }} components={{ mono: <span className="mono" /> }} />
            </span>
          </span>
          <span className="grow" />
          <div className="suggestion-facts">
            <span className="cost">{t('suggestion:facts.noCost')}</span>
          </div>
        </>
      )}
    </section>
  );
}
