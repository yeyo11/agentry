import type { Milestone, MilestoneProgress, WorkItemStatus } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';
import { useMutation } from '@tanstack/react-query';
import { Check, Flag, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, useWorkItemBoard } from '../../api';
import { Menu } from '../../components/controls/Menu';
import { MoreActions } from '../../components/controls/MoreActions';
import { Dialog, useConfirm } from '../../components/Dialog';
import { ICON_SM, WorkItemStatusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, Field, Skeleton } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { columnMeta, isOpen, TASKS_PATH } from '../../lib/work-items';
import { boardItems, NO_MILESTONE } from './board/model';
import { useScopeMilestones, useTasksScope } from './toolbar/scope';
import { PhoneTasksHeader, TasksHeader } from './toolbar/TasksHeader';

const doing = (progress: MilestoneProgress) => progress.byStatus.in_progress + progress.byStatus.in_review;
const share = (part: number, total: number) => (total > 0 ? part / total : 0);

/**
 * `/tasks/milestones`: the open milestones as cards with their progress (the first one is what the
 * screen is about), the closed ones as rows, and the open items that are in none. Progress comes
 * from the items and nothing here has a date, as decided for the whole ecosystem.
 */
export function Milestones() {
  const { t } = useTranslation('tasks');
  const phone = useMediaQuery(NARROW);
  const scope = useTasksScope();
  const ids = scope.allProjects ? scope.boardProjects.map((p) => p.id) : scope.projectId && !scope.boardOff ? [scope.projectId] : [];
  const { milestones, loading, error } = useScopeMilestones(ids);
  const board = useWorkItemBoard(scope.projectId, {}, scope.settled && !scope.boardOff);
  const [editing, setEditing] = useState<{ projectId: string; milestone: Milestone | null } | null>(null);

  const open = milestones.filter((m) => m.state === 'open');
  const closed = milestones.filter((m) => m.state === 'closed');
  const loose = boardItems(board.data).filter((item) => item.milestoneId === null && item.type !== 'epic' && isOpen(item.status));
  const looseBy = Object.fromEntries(WORK_ITEM_STATUSES.map((s) => [s, loose.filter((item) => item.status === s).length])) as Record<WorkItemStatus, number>;
  const projectName = scope.project?.name ?? t('header.allProjects');
  const named = (m: Milestone) => (scope.allProjects ? scope.projectNames.get(m.projectId) : undefined);

  const create = (projectId: string | null) => {
    const target = projectId ?? scope.projectId;
    if (target) setEditing({ projectId: target, milestone: null });
  };
  const newButton = (primary: boolean) =>
    scope.allProjects ? (
      <Menu
        label={t('milestones.pickProject')}
        entries={[{ id: 'projects', label: t('actions.pickProject'), items: scope.boardProjects.map((p) => ({ id: p.id, label: p.name, onSelect: () => create(p.id) })) }]}
        trigger={
          phone ? (
            <button type="button" className="icon-btn" aria-label={t('milestones.new')}>
              <Plus {...ICON_SM} />
            </button>
          ) : (
            <button type="button" className={`btn ${primary ? 'btn-primary' : ''}`.trim()}>
              <Plus {...ICON_SM} />
              {t('milestones.new')}
            </button>
          )
        }
      />
    ) : phone ? (
      <button type="button" className="icon-btn" aria-label={t('milestones.new')} onClick={() => create(null)}>
        <Plus {...ICON_SM} />
      </button>
    ) : (
      <button type="button" className={`btn ${primary ? 'btn-primary' : ''}`.trim()} onClick={() => create(null)}>
        <Plus {...ICON_SM} />
        {t('milestones.new')}
      </button>
    );

  const nothing = !loading && milestones.length === 0;
  const subtitle = (
    <>
      {projectName} · {t('milestones.summary', { open: t('milestones.summaryOpen', { count: open.length }), closed: t('milestones.summaryClosed', { count: closed.length }) })}.{' '}
      {t('milestones.explain')}
    </>
  );

  let body;
  if (scope.boardOff && scope.project)
    body = (
      <section className="card glow-top workitem-empty">
        <Empty illustration="board" size={phone ? 'md' : 'lg'} title={t('empty.offTitle')} action={<Link to="/projects" className="btn">{t('empty.offAction')}</Link>}>
          {t('empty.offBody', { project: scope.project.name })}
        </Empty>
      </section>
    );
  else if (error && milestones.length === 0) body = <ErrorBox error={error} />;
  else if (loading || !scope.settled)
    body = (
      <Card>
        <Skeleton rows={6} height={22} />
      </Card>
    );
  else if (nothing)
    body = (
      <section className="card glow-top workitem-empty">
        <Empty
          illustration="board"
          size={phone ? 'md' : 'lg'}
          title={t('milestones.emptyTitle')}
          action={
            scope.allProjects ? (
              newButton(true)
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => create(null)}>
                <Plus {...ICON_SM} />
                {t('milestones.emptyAction')}
              </button>
            )
          }
        >
          {t('milestones.emptyBody')}
        </Empty>
      </section>
    );
  else
    body = (
      <>
        {open.length > 0 && (
          <section className="milestone-section" aria-labelledby="milestones-open">
            <h2 id="milestones-open" className="milestone-label">
              {t('milestones.open')} <span className="mono">{open.length}</span>
            </h2>
            {open.map((milestone, index) => (
              <MilestoneCard key={milestone.id} milestone={milestone} project={named(milestone)} featured={index === 0} phone={phone} onEdit={() => setEditing({ projectId: milestone.projectId, milestone })} />
            ))}
          </section>
        )}
        {closed.length > 0 && (
          <section className="milestone-section" aria-labelledby="milestones-closed">
            <h2 id="milestones-closed" className="milestone-label">
              {t('milestones.closed')} <span className="mono">{closed.length}</span>
            </h2>
            <div className="card milestone-rows">
              {closed.map((milestone) => (
                <ClosedRow key={milestone.id} milestone={milestone} project={named(milestone)} phone={phone} />
              ))}
            </div>
          </section>
        )}
        {loose.length > 0 && (
          <section className="milestone-section" aria-labelledby="milestones-none">
            <h2 id="milestones-none" className="milestone-label">
              {t('milestones.none')} <span className="mono">{loose.length}</span>
            </h2>
            <div className="card milestone-rows">
              <div className="milestone-row">
                <Flag size={15} strokeWidth={1.75} aria-hidden className="milestone-flag" />
                <span className="milestone-row-title">{t('milestones.noneRow', { count: loose.length })}</span>
                {!phone && <StatusCounts counts={looseBy} />}
                <Link to={`${TASKS_PATH}?view=list&milestone=${NO_MILESTONE}`} className="btn btn-small milestone-row-action">
                  {t('milestones.viewList')}
                </Link>
              </div>
            </div>
          </section>
        )}
      </>
    );

  return (
    <div className="tasks-page milestones-page">
      {phone ? (
        <PhoneTasksHeader view="milestones" title={t('views.milestones')} subtitle={projectName} action={!scope.boardOff ? newButton(false) : undefined} />
      ) : (
        <TasksHeader view="milestones" subtitle={subtitle} actions={!scope.boardOff && !nothing ? newButton(true) : null} />
      )}
      {body}
      {editing && <MilestoneForm projectId={editing.projectId} milestone={editing.milestone} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** The bar of a milestone: done in ok, the items under way in a neutral tone, the rest as track. */
function MilestoneBar({ progress }: { progress: MilestoneProgress }) {
  const { t } = useTranslation('tasks');
  const under = doing(progress);
  return (
    <span className="milestone-bar" role="img" aria-label={t('milestones.progressLabel', { done: progress.done, total: progress.total, doing: under })}>
      <i className="done" style={{ width: `${share(progress.done, progress.total) * 100}%` }} />
      <i className="doing" style={{ width: `${share(under, progress.total) * 100}%` }} />
    </span>
  );
}

/** How many items each column holds, by its glyph: the open milestone's footer and "No milestone". */
function StatusCounts({ counts }: { counts: Record<WorkItemStatus, number> }) {
  const { t } = useTranslation('tasks');
  return (
    <ul className="milestone-counts" aria-label={t('milestones.byColumn')}>
      {WORK_ITEM_STATUSES.map((status) => (
        <li key={status} title={t('milestones.columnCount', { column: t(columnMeta(status).label), count: counts[status] })}>
          <WorkItemStatusIcon status={status} decorative />
          <span aria-hidden>{counts[status]}</span>
          <span className="sr-only">{t('milestones.columnCount', { column: t(columnMeta(status).label), count: counts[status] })}</span>
        </li>
      ))}
    </ul>
  );
}

function useMilestoneChange(milestone: Milestone) {
  const toast = useToast();
  const { t } = useTranslation('tasks');
  return useMutation({
    mutationFn: (state: Milestone['state']) => api.updateMilestone(milestone.id, { state }),
    onError: (error) => toast.error(t('milestones.changeFailed'), error),
  });
}

function MilestoneCard({ milestone, project, featured, phone, onEdit }: { milestone: Milestone; project?: string | undefined; featured: boolean; phone: boolean; onEdit: () => void }) {
  const { t } = useTranslation('tasks');
  const confirm = useConfirm();
  const toast = useToast();
  const change = useMilestoneChange(milestone);
  const remove = useMutation({ mutationFn: () => api.deleteMilestone(milestone.id), onError: (error) => toast.error(t('milestones.changeFailed'), error) });
  const { progress } = milestone;
  const pending = progress.total - progress.done - doing(progress);
  const percent = formatNumber(share(progress.done, progress.total), { style: 'percent', maximumFractionDigits: 0 });
  const legend = (
    <div className="milestone-legend">
      <span>
        <i className="done" />
        {t('milestones.done', { count: progress.done })}
      </span>
      <span>
        <i className="doing" />
        {phone ? t('milestones.doingShort', { count: doing(progress) }) : t('milestones.doing', { count: doing(progress) })}
      </span>
      <span>
        <i />
        {t('milestones.pending', { count: pending })}
      </span>
    </div>
  );
  const actions = (
    <MoreActions
      label={t('milestones.menu', { name: milestone.name })}
      entries={[
        { id: 'edit', label: t('milestones.edit'), icon: Pencil, onSelect: onEdit },
        { id: 'close', label: t('milestones.close'), icon: Check, onSelect: () => change.mutate('closed') },
        {
          id: 'delete',
          label: t('milestones.delete'),
          icon: Trash2,
          destructive: true,
          onSelect: () =>
            void confirm({ title: t('milestones.deleteTitle', { name: milestone.name }), body: t('milestones.deleteBody'), confirmLabel: t('milestones.delete'), danger: true }).then(
              (ok) => ok && remove.mutate(),
            ),
        },
      ]}
    />
  );
  const heading = (
    <div className="milestone-head">
      <Flag size={16} strokeWidth={1.75} aria-hidden className="milestone-flag" />
      <h3 className="milestone-name">{milestone.name}</h3>
      {project && <span className="workitem-project">{project}</span>}
      <span className="badge milestone-state">{t('milestones.stateOpen')}</span>
    </div>
  );
  if (phone)
    return (
      <article className={`card milestone-card is-phone ${featured ? 'grad-border' : ''}`.trim()}>
        {heading}
        {milestone.description && <p className="milestone-desc is-lead">{milestone.description}</p>}
        <div className="milestone-figure">
          <span className={`milestone-pct ${featured ? 'grad-text' : ''}`.trim()}>{percent}</span>
          <span className="milestone-of">{t('milestones.doneOf', { done: progress.done, total: progress.total })}</span>
        </div>
        <MilestoneBar progress={progress} />
        {legend}
        <div className="milestone-phone-actions">
          <Link to={`${TASKS_PATH}?milestone=${encodeURIComponent(milestone.id)}`} className="btn btn-small">
            {t('milestones.viewBoard')}
          </Link>
          {actions}
        </div>
      </article>
    );
  return (
    <article className={`card milestone-card ${featured ? 'grad-border' : ''}`.trim()}>
      <div className="milestone-top">
        <div className="milestone-text">
          {heading}
          {milestone.description && <p className="milestone-desc">{milestone.description}</p>}
        </div>
        <span className={`milestone-pct ${featured ? 'grad-text' : ''}`.trim()}>{percent}</span>
      </div>
      <MilestoneBar progress={progress} />
      <div className="milestone-foot">
        {legend}
        <span className="grow" />
        <StatusCounts counts={progress.byStatus} />
        <span className="milestone-sep" aria-hidden />
        <Link to={`${TASKS_PATH}?milestone=${encodeURIComponent(milestone.id)}`} className="link-btn milestone-link">
          {t('milestones.viewBoard')}
        </Link>
        {actions}
      </div>
    </article>
  );
}

function ClosedRow({ milestone, project, phone }: { milestone: Milestone; project?: string | undefined; phone: boolean }) {
  const { t } = useTranslation('tasks');
  const change = useMilestoneChange(milestone);
  const { progress } = milestone;
  const percent = formatNumber(share(progress.done, progress.total), { style: 'percent', maximumFractionDigits: 0 });
  return (
    <div className="milestone-row">
      {!phone && <Flag size={15} strokeWidth={1.75} aria-hidden className="milestone-flag" />}
      <span className="milestone-name">{milestone.name}</span>
      <span className="milestone-row-title">
        {milestone.description.split('\n')[0]}
        {project && <span className="workitem-row-project"> · {project}</span>}
      </span>
      {!phone && (
        <>
          <MilestoneBar progress={progress} />
          <span className="milestone-row-num">
            {progress.done}/{progress.total} · {percent}
          </span>
        </>
      )}
      <span className="badge badge-ok">
        <Check size={11} strokeWidth={2.5} aria-hidden />
        {t('milestones.stateClosed')}
      </span>
      {!phone && (
        <button type="button" className="btn btn-small milestone-row-action" disabled={change.isPending} onClick={() => change.mutate('open')}>
          <RotateCcw size={13} strokeWidth={1.75} aria-hidden />
          {t('milestones.reopen')}
        </button>
      )}
    </div>
  );
}

/** Creates or edits a milestone: a name and a Markdown description, and no date. */
function MilestoneForm({ projectId, milestone, onClose }: { projectId: string; milestone: Milestone | null; onClose: () => void }) {
  const { t } = useTranslation('tasks');
  const toast = useToast();
  const [name, setName] = useState(milestone?.name ?? '');
  const [description, setDescription] = useState(milestone?.description ?? '');
  const save = useMutation({
    mutationFn: () => (milestone ? api.updateMilestone(milestone.id, { name: name.trim(), description }) : api.createMilestone(projectId, { name: name.trim(), description })),
    onSuccess: onClose,
    onError: (error) => toast.error(t('milestones.failed'), error),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) save.mutate();
  };
  return (
    <Dialog
      title={milestone ? t('milestones.formEdit') : t('milestones.formNew')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('milestones.cancel')}
          </button>
          <button type="submit" form="milestone-form" className="btn btn-primary" disabled={!name.trim() || save.isPending}>
            {milestone ? t('milestones.save') : t('milestones.create')}
          </button>
        </>
      }
    >
      <form id="milestone-form" className="milestone-form" onSubmit={submit}>
        <Field label={t('milestones.name')} hint={t('milestones.nameHint')}>
          <input data-autofocus className="mono" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t('milestones.description')} hint={t('milestones.descriptionHint')}>
          <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
