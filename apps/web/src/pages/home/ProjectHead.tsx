import type { Project } from '@agentry/shared';
import { ChevronRight, MessageCircle, Pencil, Plus, Sparkle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { useAssistantRuns, useDocuments, useProjectSettings } from '../../api';
import type { MenuEntry } from '@agentry/ui/components/controls/Menu';
import { ICON, ICON_SM, Monogram } from '@agentry/ui/components/icons';
import { WorkItemKey } from '../../components/work-item-icons';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { formatNumber } from '@agentry/ui/lib/format';
import { NEW_TASK_PATH } from '../../lib/work-items';
import { assistantPath, pendingProposalCount, projectPath } from '../assistant/model';
import type { ProjectViewId } from '../dashboard/views';

const newChatPath = (project: Project) => `/chats/new?cwd=${encodeURIComponent(project.path)}`;

/**
 * The top of every tab: who the project is (its monogram, name, key and template), where it lives
 * and how much it holds, and the ways to start work in it: its assistant, a chat, a task. "New task"
 * is the gradient only on Resumen; on a tab with a primary of its own it steps back. The assistant
 * leads them as a ghost (decision 3), since once a project has a team nothing else on its page
 * leads to it. A tab that is a form of its own (Ajustes, Recursos) has no actions here, as their
 * references draw it: its own Save or Create is the thing to press there.
 */
export function ProjectHead({
  project,
  primaryTask,
  actions = true,
  onEditHome,
}: {
  project: Project;
  primaryTask: boolean;
  actions?: boolean;
  /** On Resumen: turns the dashboard into its edit mode */
  onEditHome?: () => void;
}) {
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
          {onEditHome && (
            <button type="button" className="btn btn-quiet" onClick={onEditHome}>
              <Pencil {...ICON_SM} />
              {t('home:edit.enter')}
            </button>
          )}
          <Link
            to={assistantPath(project.id)}
            className="btn btn-quiet project-head-assistant"
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
export function PhoneHead({ project, onEditHome }: { project: Project; onEditHome?: () => void }) {
  const { t } = useTranslation(['projects', 'home']);
  const navigate = useNavigate();
  const more: MenuEntry[] = [
    ...(onEditHome ? [{ id: 'edit-home', label: t('home:edit.enter'), icon: Pencil, onSelect: onEditHome }] : []),
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

/**
 * The assistant as a phone header's "⋯" offers it. On a phone every tab is a screen of its own, so
 * each one's sheet carries it (gap 8), Team and its activity included: the project's own screen has
 * the assistant row, which a tab's screen does not show.
 */
export function assistantEntry(project: Pick<Project, 'id' | 'exists'>, label: string, go: (path: string) => void): MenuEntry {
  return { id: 'assistant', label, icon: Sparkle, disabled: !project.exists, onSelect: () => go(assistantPath(project.id)) };
}

/**
 * What a phone tab's "⋯" offers: the assistant on every tab, then the ways to start work in the
 * project, as the project's own head has them. Ajustes is a form with its own Save, and Recursos has
 * its "+" in its toolbar, so they offer the assistant alone.
 */
export function phoneViewMore(project: Project, view: ProjectViewId, t: TFunction<'projects'>, go: (path: string) => void): MenuEntry[] {
  const assistant = assistantEntry(project, t('head.assistant'), go);
  if (view === 'settings' || view === 'resources') return [assistant];
  return [
    assistant,
    { id: 'chat', label: t('worktrees.newChatHere'), icon: MessageCircle, disabled: !project.exists, onSelect: () => go(newChatPath(project)) },
    ...(project.modules.includes('board') ? [{ id: 'task', label: t('head.newTask'), icon: Plus, onSelect: () => go(NEW_TASK_PATH) }] : []),
  ];
}

/**
 * On a phone a tab opens as its own screen (MobileMemoria, MobileDocumentos, MobileProyectoAjustes…),
 * headed by its name and the project it belongs to, with where it reads from when it reads a folder,
 * and a "⋯" that always leads to the assistant.
 */
export function PhoneViewHead({ project, view }: { project: Project; view: ProjectViewId }) {
  const { t } = useTranslation(['home', 'projects']);
  const { t: tp } = useTranslation('projects');
  const navigate = useNavigate();
  const root = useDocuments(view === 'documents' ? project.id : null).data?.root;
  const where = view === 'documents' && root ? `${root.replace(/\/?$/, '/')}` : view === 'resources' ? '.claude/' : null;
  return (
    <PhoneHeader
      className="project-phone-head"
      title={t(`tabs.${view}`)}
      subtitle={where ? `${project.name} · ${where}` : project.name}
      back={{ label: t('dashboard.back'), fallback: projectPath(project.id) }}
      more={phoneViewMore(project, view, tp, (path) => navigate(path))}
    />
  );
}
