import type { Project } from '@agentry/shared';
import { ChevronLeft, MessageCircle, Plus, Sparkle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useProjectSettings } from '../../api';
import { ICON, ICON_SM, Monogram, WorkItemKey } from '../../components/icons';
import { formatNumber } from '../../lib/format';
import { NEW_TASK_PATH } from '../../lib/work-items';
import { assistantPath } from '../assistant/model';

/**
 * The top of every tab: who the project is (its monogram, name, key and template), where it lives
 * and how much it holds, and the ways to start work in it: its assistant, a chat, a task. "New task"
 * is the gradient only on Resumen; on a tab with a primary of its own it steps back. The assistant
 * is always here, since once a project has a team nothing else on its page leads to it.
 */
export function ProjectHead({ project, primaryTask }: { project: Project; primaryTask: boolean }) {
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
      <div className="page-actions">
        <Link to={assistantPath(project.id)} className="btn project-head-assistant" aria-disabled={!project.exists || undefined} aria-label={t('projects:head.assistantOf', { name: project.name })}>
          <Sparkle {...ICON_SM} />
          {t('projects:head.assistant')}
        </Link>
        <Link
          to={`/chats/new?cwd=${encodeURIComponent(project.path)}`}
          className={board ? 'btn' : 'btn btn-primary'}
          aria-disabled={!project.exists || undefined}
          aria-label={t('projects:worktrees.newChatIn', { name: project.name })}
        >
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
    </header>
  );
}

/** A phone's project: back to the list, then who it is, in one line under the name, and its assistant. */
export function PhoneHead({ project }: { project: Project }) {
  const { t } = useTranslation('projects');
  return (
    <header className="page-header project-head project-head-phone">
      <Link to="/projects" className="icon-btn" aria-label={t('head.backToProjects')}>
        <ChevronLeft {...ICON} />
      </Link>
      <Monogram name={project.name} size={40} project />
      <div className="page-header-text project-head-text">
        <h1>{project.name}</h1>
        <span className="mono small muted ellipsis">
          {project.key} · {project.path}
        </span>
      </div>
      <PhoneAssistantLink project={project} />
    </header>
  );
}

/**
 * The assistant as a phone head draws it, an icon at the end: every tab's head carries it, as the
 * desktop head does, so no tab is a dead end on the way to it.
 */
export function PhoneAssistantLink({ project }: { project: Pick<Project, 'id' | 'name' | 'exists'> }) {
  const { t } = useTranslation('projects');
  return (
    <Link to={assistantPath(project.id)} className="icon-btn project-head-assistant" aria-disabled={!project.exists || undefined} aria-label={t('head.assistantOf', { name: project.name })}>
      <Sparkle {...ICON} />
    </Link>
  );
}
