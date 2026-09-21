import type { Project, ProjectCandidate } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Download, Eraser, FolderGit2, FolderPlus, GitBranch, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useProjectCandidates, useProjects } from '../api';
import { Collapsible, Combobox } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON_SM, Monogram } from '../components/icons';
import { ListToolbar } from '../components/ListToolbar';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, Field, Loading, PageHeader, Tag } from '../components/ui';
import { formatNumber, timeAgo } from '../lib/format';
import { matchesText, PROJECT_SORTERS, type ProjectSort } from '../lib/lists';

const PROJECT_SORTS = Object.keys(PROJECT_SORTERS) as ProjectSort[];

/** What a change to the projects makes stale: the list, what is offered, and everything scoped by a project. */
function useRefreshProjects() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.projects });
    void queryClient.invalidateQueries({ queryKey: keys.chats });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
    void queryClient.invalidateQueries({ queryKey: keys.memoryProjects });
  };
}

function ImportForm({ candidates, onDone }: { candidates: ProjectCandidate[]; onDone: () => void }) {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const refresh = useRefreshProjects();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => api.importProject({ path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  return (
    <Card title={t('page.importDirectory')}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label={t('importForm.directory')} hint={t('importForm.directoryHint')}>
          <Combobox
            aria-label={t('importForm.directory')}
            placeholder="/home/you/code/my-project"
            value={path}
            onChange={setPath}
            options={candidates.map((c) => ({ value: c.path, label: c.name, hint: t('importForm.candidateHint', { count: c.chatCount, n: formatNumber(c.chatCount), path: c.path }) }))}
          />
        </Field>
        <Field label={t('importForm.nameOptional')} hint={t('importForm.nameOptionalHint')}>
          <input value={name} placeholder={t('work:projects.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorBox error={add.error} title={t('importForm.failed')} />
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!path.trim() || add.isPending}>
            {add.isPending ? t('importForm.importing') : t('importForm.import')}
          </button>
          <button type="button" className="btn" onClick={onDone}>
            {t('common:actions.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const refresh = useRefreshProjects();
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), gitUrl: gitUrl.trim() || undefined }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  return (
    <Card title={t('work:projects.newProjectCard')}>
      <div className="form">
        <Field label={t('work:projects.name')} hint={t('work:projects.nameHint')}>
          <input value={name} placeholder={t('work:projects.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('work:projects.gitUrl')} hint={t('work:projects.gitUrlHint')}>
          <input value={gitUrl} placeholder="https://github.com/owner/repo.git" onChange={(e) => setGitUrl(e.target.value)} />
        </Field>
        <ErrorBox error={create.error} title={t('work:projects.createFailed')} />
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? (gitUrl.trim() ? t('work:projects.cloning') : t('work:projects.creating')) : t('work:projects.create')}
          </button>
          <button className="btn" onClick={onDone}>
            {t('common:actions.cancel')}
          </button>
        </div>
      </div>
    </Card>
  );
}

/** The directories with the most chats: what a first start offers instead of an empty screen. */
function Candidates({ candidates, first }: { candidates: ProjectCandidate[]; first: boolean }) {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const refresh = useRefreshProjects();
  const toast = useToast();
  const add = useMutation({
    mutationFn: (candidate: ProjectCandidate) => api.importProject({ path: candidate.path }),
    onSuccess: (project) => {
      refresh();
      toast.success(t('candidates.imported', { name: project.name }), t('candidates.adopted', { count: project.chatCount, n: formatNumber(project.chatCount) }));
    },
    onError: (error) => toast.error(t('importForm.failed'), error),
  });
  const list = (
    <ul className="candidate-list">
      {candidates.map((c) => (
        <li key={c.path} className="candidate-row">
          <div className="candidate-main">
            <strong className="break">{c.name}</strong>
            <span className="mono small muted break">{c.path}</span>
            <span className="small muted">
              {t('candidates.chats', { count: c.chatCount, n: formatNumber(c.chatCount) })}
              {c.lastActivity ? t('candidates.last', { ago: timeAgo(c.lastActivity) }) : ''}
            </span>
          </div>
          <button type="button" className="btn btn-small" disabled={add.isPending} onClick={() => add.mutate(c)} aria-label={t('candidates.importNamed', { name: c.name })}>
            <Download {...ICON_SM} /> {t('importForm.import')}
          </button>
        </li>
      ))}
    </ul>
  );
  if (first) {
    return (
      <Card title={t('candidates.firstTitle')}>
        <p className="muted">{t('candidates.firstBody')}</p>
        {list}
      </Card>
    );
  }
  return (
    <Collapsible className="card fold-card" title={<span className="fold-card-title">{t('candidates.others', { n: formatNumber(candidates.length) })}</span>}>
      {list}
    </Collapsible>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const refresh = useRefreshProjects();
  const confirm = useConfirm();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (name: string) => api.renameProject(project.id, name),
    onSuccess: () => {
      refresh();
      setRenaming(null);
    },
    onError: (error) => toast.error(t('card.renameFailed'), error),
  });
  const remove = useMutation({
    mutationFn: () => api.removeProject(project.id),
    onSuccess: () => {
      refresh();
      toast.success(t('card.removed', { name: project.name }), t('card.removedHint'));
    },
    onError: (error) => toast.error(t('card.removeFailed'), error),
  });
  const purge = useMutation({
    mutationFn: () => api.purgeProject(project.id),
    onSuccess: (done) => {
      refresh();
      toast.success(t('card.purged', { name: project.name }), done.detail);
    },
    onError: (error) => toast.error(t('card.purgeFailed'), error),
  });

  const askRemove = async () => {
    const ok = await confirm({
      title: t('card.removeTitle', { name: project.name }),
      body: t('card.removeBody', { count: project.chatCount, n: formatNumber(project.chatCount) }),
      confirmLabel: t('card.removeConfirm'),
    });
    if (ok) remove.mutate();
  };
  const askPurge = async () => {
    const ok = await confirm({
      title: t('card.purgeTitle', { name: project.name }),
      body: (
        <Trans
          t={t}
          i18nKey="card.purgeBody"
          count={project.chatCount}
          values={{ n: formatNumber(project.chatCount) }}
          components={{ code: <code />, strong: <strong /> }}
        />
      ),
      confirmLabel: t('card.purgeConfirm'),
      danger: true,
    });
    if (ok) purge.mutate();
  };

  return (
    <li className={`lrow project-row ${project.exists ? '' : 'is-warn'}`.trim()}>
      <div className="lrow-head">
        <span className="lrow-mark">
          <Monogram name={project.name} />
        </span>
        <div className="lrow-main">
          {renaming === null ? (
            <h2 className="lrow-title">
              {project.name}
              {!project.exists && <Tag tone="warn">{t('work:projects.missing')}</Tag>}
            </h2>
          ) : (
            <form
              className="rename-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (renaming.trim()) rename.mutate(renaming.trim());
              }}
            >
              <input aria-label={t('card.nameLabel')} value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus />
              <button type="submit" className="btn btn-small btn-primary" disabled={!renaming.trim() || rename.isPending}>
                {t('config:shared.save')}
              </button>
              <button type="button" className="btn btn-small" onClick={() => setRenaming(null)}>
                {t('common:actions.cancel')}
              </button>
            </form>
          )}
          <span className="lrow-sub">
            <span className="mono">{project.path}</span>
            <span>{t('card.chats', { count: project.chatCount, n: formatNumber(project.chatCount) })}</span>
            <span>{t('work:projects.lastActivity', { ago: timeAgo(project.lastActivity) })}</span>
            {project.worktrees.length > 0 && (
              <span className="meta-icon">
                <GitBranch size={12} strokeWidth={1.75} aria-hidden /> {t('work:projects.worktrees', { count: project.worktrees.length })}
              </span>
            )}
          </span>
        </div>
        <div className="lrow-actions">
        <Link to={`/?project=${encodeURIComponent(project.id)}`} className="btn btn-small btn-primary" aria-label={t('card.openNamed', { name: project.name })}>
          {t('common:actions.open')} <ArrowRight {...ICON_SM} />
        </Link>
        <button type="button" className="btn btn-small" onClick={() => setRenaming(project.name)} disabled={renaming !== null} aria-label={t('card.renameNamed', { name: project.name })}>
          <Pencil {...ICON_SM} /> {t('card.rename')}
        </button>
        <button type="button" className="btn btn-small" onClick={() => void askRemove()} disabled={remove.isPending} aria-label={t('card.removeNamed', { name: project.name })}>
          <Trash2 {...ICON_SM} /> {t('common:actions.remove')}
        </button>
        <button type="button" className="btn btn-small btn-danger" onClick={() => void askPurge()} disabled={purge.isPending} aria-label={t('card.purgeNamed', { name: project.name })}>
          <Eraser {...ICON_SM} /> {t('card.purge')}
        </button>
        </div>
      </div>
    </li>
  );
}

export function Projects() {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const [adding, setAdding] = useState<'import' | 'create' | null>(null);
  const { data, error, isLoading } = useProjects();
  const projects = data ?? [];
  // Candidates are always there to offer; the page decides how loudly, and only asks once it knows
  const candidates = useProjectCandidates(!isLoading);
  const offered = candidates.data ?? [];
  const first = !isLoading && projects.length === 0;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ProjectSort>('activity');
  const shown = projects.filter((project) => matchesText(search, [project.name, project.path])).sort(PROJECT_SORTERS[sort]);

  return (
    <>
      <PageHeader
        title={t('work:projects.title')}
        subtitle={t('page.subtitle', { n: formatNumber(projects.length) })}
        actions={
          adding === null && (
            <>
              <button className="btn" onClick={() => setAdding('create')}>
                <Plus size={14} strokeWidth={2} aria-hidden />
                {t('work:projects.newProject')}
              </button>
              <button className="btn btn-primary" onClick={() => setAdding('import')}>
                <FolderPlus size={14} strokeWidth={2} aria-hidden />
                {t('page.importDirectory')}
              </button>
            </>
          )
        }
      />
      {adding === 'import' && <ImportForm candidates={offered} onDone={() => setAdding(null)} />}
      {adding === 'create' && <NewProjectForm onDone={() => setAdding(null)} />}
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : projects.length === 0 ? (
        offered.length === 0 && (
          <Empty icon={FolderGit2} title={t('work:projects.empty')}>
            {t('page.emptyHint')}
          </Empty>
        )
      ) : (
        <div>
          <ListToolbar
            search={{ value: search, onChange: setSearch, placeholder: t('list.searchPlaceholder'), label: t('list.searchLabel') }}
            sort={{ value: sort, options: PROJECT_SORTS.map((value) => ({ value, label: t(`list.sort.${value}`) })), onChange: (v) => setSort(PROJECT_SORTS.find((s) => s === v) ?? 'activity'), label: t('list.sortLabel') }}
          />
          {shown.length === 0 ? (
            <Empty icon={FolderGit2} title={t('list.noneMatch')} />
          ) : (
            <ul className="lrows">
              {shown.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </ul>
          )}
        </div>
      )}
      {offered.length > 0 && <Candidates candidates={offered} first={first} />}
    </>
  );
}
