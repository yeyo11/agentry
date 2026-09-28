import { Check, ChevronDown, Flag, Kanban, List, Plus, Sparkle, SquareCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Menu } from '../../../components/controls/Menu';
import { ProjectSelector } from '../../../components/ProjectSelector';
import { BackButton } from '../../../components/shell/BackButton';
import { ICON_SM } from '../../../components/icons';
import { Segmented, usePageTitle } from '../../../components/ui';
import { MILESTONES_PATH, TASKS_PATH, VIEW_PARAM } from '../../../lib/work-items';

export type TasksViewName = 'board' | 'list' | 'milestones';

/** Board, List and Milestones: three views of one Tasks, so one control switches them, keeping the filters. */
export function ViewSwitch({ view, wide = false }: { view: TasksViewName; wide?: boolean }) {
  const { t } = useTranslation('tasks');
  const navigate = useNavigate();
  const { search } = useLocation();
  const go = (next: TasksViewName) => {
    if (next === 'milestones') return navigate(MILESTONES_PATH);
    // The filters travel between the board and the list; the milestones page has none
    const params = new URLSearchParams(view === 'milestones' ? '' : search);
    if (next === 'list') params.set(VIEW_PARAM, 'list');
    else params.delete(VIEW_PARAM);
    const query = params.toString();
    navigate(`${TASKS_PATH}${query ? `?${query}` : ''}`);
  };
  const option = (value: TasksViewName, Icon: typeof Kanban) => ({
    value,
    label: (
      <span className="workitem-view-option">
        {!wide && <Icon {...ICON_SM} />}
        {t(`views.${value}`)}
      </span>
    ),
  });
  return (
    <div className={`workitem-views ${wide ? 'is-wide' : ''}`.trim()}>
      <Segmented value={view} label={t('header.view')} onChange={go} options={[option('board', Kanban), option('list', List), option('milestones', Flag)]} />
    </div>
  );
}

/** "Select": pressed while selection mode is on, drawn with the chosen segment's fill, never the gradient. */
export function SelectButton({ on, onChange, icon = false }: { on: boolean; onChange: (on: boolean) => void; icon?: boolean }) {
  const { t } = useTranslation('tasks');
  if (icon)
    return (
      <button type="button" className="icon-btn workitem-select-icon" aria-pressed={on} aria-label={t('actions.selectToOrchestrate')} onClick={() => onChange(!on)}>
        <SquareCheck {...ICON_SM} />
      </button>
    );
  return (
    <button type="button" className="btn workitem-select" aria-pressed={on} onClick={() => onChange(!on)}>
      {on ? <Check {...ICON_SM} /> : <SquareCheck {...ICON_SM} />}
      {t('actions.select')}
    </button>
  );
}

/** "Suggest tasks": the project assistant proposes work items; never the gradient, "New task" holds it. */
export function SuggestButton({ onClick, icon = false }: { onClick: () => void; icon?: boolean }) {
  const { t } = useTranslation('tasks');
  if (icon)
    return (
      <button type="button" className="icon-btn workitem-suggest-icon" aria-label={t('suggest.button')} onClick={onClick}>
        <Sparkle {...ICON_SM} />
      </button>
    );
  return (
    <button type="button" className="btn workitem-suggest" onClick={onClick}>
      <Sparkle {...ICON_SM} />
      {t('suggest.button')}
    </button>
  );
}

/**
 * "New task": the zone's primary action unless something else holds it (Orchestrate while
 * selecting, the empty board's own button). With All projects it first asks in which project.
 */
export function NewTaskButton({
  primary,
  projects,
  onNew,
}: {
  primary: boolean;
  /** Set on All projects: the projects a task can go into */
  projects?: ReadonlyArray<{ id: string; name: string }> | undefined;
  onNew: (projectId: string | null) => void;
}) {
  const { t } = useTranslation('tasks');
  const className = `btn ${primary ? 'btn-primary' : ''} page-action-fab`.replace(/\s+/g, ' ').trim();
  if (projects)
    return (
      <Menu
        label={t('actions.pickProject')}
        align="end"
        entries={[{ id: 'projects', label: t('actions.pickProject'), items: projects.map((p) => ({ id: p.id, label: p.name, onSelect: () => onNew(p.id) })) }]}
        trigger={
          <button type="button" className={className}>
            <Plus {...ICON_SM} />
            {t('actions.newTask')}
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
          </button>
        }
      />
    );
  return (
    <button type="button" className={className} onClick={() => onNew(null)}>
      <Plus {...ICON_SM} />
      {t('actions.newTask')}
    </button>
  );
}

/** The desktop header: the title and its line of figures, then the views and the page's actions. */
export function TasksHeader({ subtitle, view, actions }: { subtitle: ReactNode; view: TasksViewName; actions: ReactNode }) {
  const { t } = useTranslation('tasks');
  usePageTitle(t('title'));
  return (
    <header className="page-header workitem-head">
      <div className="page-header-text">
        <h1>{t('title')}</h1>
        <div className="muted workitem-head-sub">{subtitle}</div>
      </div>
      <div className="page-actions">
        <ViewSwitch view={view} />
        {actions}
      </div>
    </header>
  );
}

/**
 * The phone's header, which stands for the top bar there (MobileTablero, MobileHitos): the way back,
 * the title, and beside it the project scope (the board and the list) or a line naming it (the
 * milestones), then an icon action, the views across the width under it. While choosing cards to
 * orchestrate it becomes "2 chosen" with a way out.
 */
export function PhoneTasksHeader({
  view,
  title,
  subtitle,
  action,
  selecting,
}: {
  view: TasksViewName;
  title?: string | undefined;
  subtitle?: ReactNode;
  action?: ReactNode;
  selecting?: { count: number; project: string; onClose: () => void } | undefined;
}) {
  const { t } = useTranslation('tasks');
  usePageTitle(t('title'));
  if (selecting)
    return (
      <header className="workitem-mhead is-selecting">
        <button type="button" className="icon-btn workitem-mhead-close" aria-label={t('select.close')} onClick={selecting.onClose}>
          <X {...ICON_SM} />
        </button>
        <div className="workitem-mhead-text">
          <h1>{t('select.title', { count: selecting.count })}</h1>
          <span className="mono muted">{t('select.subtitle', { project: selecting.project })}</span>
        </div>
      </header>
    );
  return (
    <>
      <header className="workitem-mhead">
        <BackButton label={t('header.back')} />
        <div className="workitem-mhead-text">
          <h1>{title ?? t('title')}</h1>
          {subtitle && <span className="mono muted">{subtitle}</span>}
        </div>
        {!subtitle && <ProjectSelector />}
        {action}
      </header>
      <ViewSwitch view={view} wide />
    </>
  );
}
