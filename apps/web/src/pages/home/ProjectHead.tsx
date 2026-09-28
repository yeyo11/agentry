import type { Project } from '@agentry/shared';
import { ChevronRight, MessageCircle, Plus, Sparkle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAssistantRuns, useProjectSettings } from '../../api';
import type { MenuEntry } from '../../components/controls/Menu';
import { ICON, ICON_SM, Monogram, WorkItemKey } from '../../components/icons';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { formatNumber } from '../../lib/format';
import { NEW_TASK_PATH } from '../../lib/work-items';
import { assistantPath, pendingProposalCount } from '../assistant/model';

const newChatPath = (project: Project) => `/chats/new?cwd=${encodeURIComponent(project.path)}`;

/**
 * The top of every tab: who the project is (its monogram, name, key and template), where it lives
 * and how much it holds, and the ways to start work in it: its assistant, a chat, a task. "New task"
 * is the gradient only on Resumen; on a tab with a primary of its own it steps back. The assistant
 * leads them as a ghost (decision 3), since once a project has a team nothing else on its page
 * leads to it. A tab that is a form of its own (Ajustes, Recursos) has no actions here, as their
 * references draw it: its own Save or Create is the thing to press there.
 */
export function ProjectHead({ project, primaryTask, actions = true }: { project: Project; primaryTask: boolean; actions?: boolean }) {
  const { t } = useTranslation(['home', 'projects', 'common']);
  const template = useProjectSettings(project.id).data?.template ?? null;
  const board = project.modules.includes('board');
  return (
    <header className="page-header project-head">
      <Monogram name={project.name} size={44} project />
      <div className="page-header-text project-head-text">
        <div className="project-head-title">
          <h1>{project.name}</h1>
          <WorkItemKey value={project.key} boxed />
          {template && <span className="badge badge-muted project-head-template">{t(`projects:templates.${template}.name`)}</span>}
        </div>
        <span className="mono small muted project-head-facts">
          <span className="ellipsis" title={project.path}>
            {project.path}
          </span>
          <span aria-hidden>·</span>
          <span>{t('projects:head.chats', { count: project.chatCount, n: formatNumber(project.chatCount) })}</span>
          <span aria-hidden>·</span>
          <span>{t('projects:head.worktrees', { count: project.worktrees.length, n: formatNumber(project.worktrees.length) })}</span>
        </span>
      </div>
      {actions && (
        <div className="page-actions">
          <Link
            to={assistantPath(project.id)}
            className="btn btn-ghost project-head-assistant"
            aria-disabled={!project.exists || undefined}
            aria-label={t('projects:head.assistantOf', { name: project.name })}
          >
            <Sparkle {...ICON_SM} />
            {t('projects:head.assistant')}
          </Link>
          <Link to={newChatPath(project)} className={board ? 'btn' : 'btn btn-primary'} aria-disabled={!project.exists || undefined} aria-label={t('projects:worktrees.newChatIn', { name: project.name })}>
            <MessageCircle {...ICON_SM} />
            {t('projects:worktrees.newChatHere')}
          </Link>
          {board && (
            <Link to={NEW_TASK_PATH} className={primaryTask ? 'btn btn-primary' : 'btn'}>
              <Plus {...ICON_SM} />
              {t('projects:head.newTask')}
            </Link>
          )}
        </div>
      )}
    </header>
  );
}

/**
 * A phone's project (MobileProyecto): the way back to the list, the monogram, the name with its key
 * and path under it, and "⋯" with the ways to start work in it. The assistant has a row of its own
 * under the header (`PhoneAssistantRow`), so it is not in the sheet twice.
 */
export function PhoneHead({ project }: { project: Project }) {
  const { t } = useTranslation('projects');
  const navigate = useNavigate();
  const more: MenuEntry[] = [
    { id: 'chat', label: t('worktrees.newChatHere'), icon: MessageCircle, disabled: !project.exists, onSelect: () => navigate(newChatPath(project)) },
    ...(project.modules.includes('board') ? [{ id: 'task', label: t('head.newTask'), icon: Plus, onSelect: () => navigate(NEW_TASK_PATH) }] : []),
  ];
  return (
    <PhoneHeader
      className="project-phone-head"
      lead={<Monogram name={project.name} size={36} project />}
      title={project.name}
      subtitle={`${project.key} · ${project.path}`}
      back={{ label: t('head.backToProjects'), fallback: '/projects' }}
      more={more}
      moreTitle={project.name}
    />
  );
}

/**
 * The phone's way to the project assistant (decision 3): a row above the sections, saying how many
 * of its proposals wait for the person, or what it does when none do.
 */
export function PhoneAssistantRow({ project }: { project: Project }) {
  const { t } = useTranslation('projects');
  const pending = pendingProposalCount(useAssistantRuns(project.id).data);
  return (
    <Link to={assistantPath(project.id)} className="card project-assistant-row" aria-disabled={!project.exists || undefined}>
      <span className="project-tab-cell-icon is-accent" aria-hidden>
        <Sparkle {...ICON} />
      </span>
      <span className="project-assistant-row-text">
        <span className="project-assistant-row-title">{t('head.assistantRow')}</span>
        <span className="small muted">{pending > 0 ? t('head.assistantPending', { count: pending, n: formatNumber(pending) }) : t('head.assistantIdle')}</span>
      </span>
      <ChevronRight {...ICON_SM} className="settings-cell-chevron" />
    </Link>
  );
}
