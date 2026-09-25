import type { Project, ProjectCandidate } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Ellipsis, FolderOpen, FolderPlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useChats, useProjectCandidates, useProjects } from '../api';
import { Combobox, Menu, Sheet, type MenuEntry } from '../components/controls';
import { useConfirm } from '../components/Dialog';
import { ICON, ICON_SM, Monogram } from '../components/icons';
import { ListToolbar } from '../components/ListToolbar';
import { StatusDot } from '../components/motion';
import { useToast } from '../components/Toast';
import { Card, Empty, ErrorBox, Field, Loading, PageHeader, Tag } from '../components/ui';
import { intlLocale } from '../i18n/language';
import { formatDate, formatDateTime, formatNumber, timeAgo, toMs } from '../lib/format';
import { matchesText, PROJECT_SORTERS, type ProjectSort } from '../lib/lists';
import { NARROW, useMediaQuery } from '../lib/media';
import { useProjectScope } from '../lib/project-scope';
import '../insights.css';

const PROJECT_SORTS = Object.keys(PROJECT_SORTERS) as ProjectSort[];

/**
 * How long ago, as short as a stat allows ("2 d", "5 h"): `timeAgo`'s "2 d ago" does not fit a third
 * of a card at the stat's size. English keeps its narrow units, as lib/format does.
 */
function sinceShort(value: string | null): string {
  const ms = toMs(value);
  if (ms == null) return '—';
  const locale = intlLocale();
  const unit = (n: number, u: 'minute' | 'hour' | 'day') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: locale.startsWith('en') ? 'narrow' : 'short' }).format(n);
  const minutes = Math.max(1, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  return days < 30 ? unit(days, 'day') : formatDate(ms);
}

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
    <Card title={t('page.importDirectory')} className="project-form">
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
    <Card title={t('work:projects.newProjectCard')} className="project-form">
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
  const [open, setOpen] = useState(false);
  const listId = useId();
  const add = useMutation({
    mutationFn: (candidate: ProjectCandidate) => api.importProject({ path: candidate.path }),
    onSuccess: (project) => {
      refresh();
      toast.success(t('candidates.imported', { name: project.name }), t('candidates.adopted', { count: project.chatCount, n: formatNumber(project.chatCount) }));
    },
    onError: (error) => toast.error(t('importForm.failed'), error),
  });
  const list = (
    <ul className="candidate-list" id={listId}>
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
      <Card title={t('candidates.firstTitle')} className="project-candidates">
        <p className="muted">{t('candidates.firstBody')}</p>
        {list}
      </Card>
    );
  }
  // Once there are projects, the rest is a nudge rather than a list: it opens on request
  return (
    <section className="project-callout">
      <div className="project-callout-head">
        <FolderOpen {...ICON} className="project-callout-icon" />
        <div className="project-callout-text">
          <h2 className="project-callout-title">{t('candidates.moreTitle', { count: candidates.length, n: formatNumber(candidates.length) })}</h2>
          <p className="project-callout-body">{t('candidates.moreBody')}</p>
        </div>
        <button type="button" className="btn btn-small" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(!open)}>
          {open ? t('candidates.hide') : t('candidates.review')}
        </button>
      </div>
      {open && list}
    </section>
  );
}

/** Rename, remove and purge: a `⋯` menu on a desktop, a sheet of big buttons on a phone. */
function ProjectActions({ project, onRename, onRemove, onPurge }: { project: Project; onRename: () => void; onRemove: () => void; onPurge: () => void }) {
  const { t } = useTranslation(['projects']);
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const label = t('card.actionsNamed', { name: project.name });

  if (narrow) {
    // The sheet closes before the action runs, so a confirmation dialog is not stacked over it
    const run = (action: () => void) => () => {
      setOpen(false);
      action();
    };
    return (
      <>
        <button type="button" className="icon-btn project-card-more" aria-label={label} onClick={() => setOpen(true)}>
          <Ellipsis {...ICON_SM} />
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={label} side="bottom" className="project-sheet">
          <div className="project-sheet-actions">
            <button type="button" className="btn" onClick={run(onRename)}>
              <Pencil {...ICON_SM} /> {t('card.rename')}
            </button>
            <button type="button" className="btn" onClick={run(onRemove)}>
              <X {...ICON_SM} /> {t('card.remove')}
            </button>
            <button type="button" className="btn btn-danger project-sheet-purge" onClick={run(onPurge)}>
              <span className="project-sheet-purge-label">
                <Trash2 {...ICON_SM} /> {t('card.purge')}
              </span>
              <span className="project-menu-hint">{t('card.purgeHint')}</span>
            </button>
          </div>
        </Sheet>
      </>
    );
  }

  const entries: MenuEntry[] = [
    { id: 'rename', label: t('card.rename'), icon: Pencil, onSelect: onRename },
    { id: 'remove', label: t('card.remove'), icon: X, onSelect: onRemove },
    { id: 'sep', separator: true },
    {
      id: 'purge',
      label: (
        <span className="project-menu-purge">
          {t('card.purge')}
          <span className="project-menu-hint">{t('card.purgeHint')}</span>
        </span>
      ),
      icon: Trash2,
      destructive: true,
      onSelect: onPurge,
    },
  ];
  return <Menu entries={entries} label={label} className="project-card-more" />;
}

function RenameForm({ initial, pending, onSave, onCancel }: { initial: string; pending: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const { t } = useTranslation(['projects', 'common', 'config']);
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  // The menu that opened this gives focus back to its trigger as it closes; this runs after it
  useEffect(() => {
    const id = window.setTimeout(() => input.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <form
      className="rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSave(value.trim());
      }}
    >
      <input ref={input} aria-label={t('card.nameLabel')} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="btn btn-small btn-primary" disabled={!value.trim() || pending}>
        {t('config:shared.save')}
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        {t('common:actions.cancel')}
      </button>
    </form>
  );
}

function ProjectCard({ project, active, live }: { project: Project; active: boolean; live: boolean }) {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const refresh = useRefreshProjects();
  const confirm = useConfirm();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);

  const rename = useMutation({
    mutationFn: (name: string) => api.renameProject(project.id, name),
    onSuccess: () => {
      refresh();
      setRenaming(false);
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
    if (remove.isPending) return;
    const ok = await confirm({
      title: t('card.removeTitle', { name: project.name }),
      body: t('card.removeBody', { count: project.chatCount, n: formatNumber(project.chatCount) }),
      confirmLabel: t('card.removeConfirm'),
    });
    if (ok) remove.mutate();
  };
  const askPurge = async () => {
    if (purge.isPending) return;
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

  const classes = ['card', 'project-card', active ? 'is-active grad-border glow-top' : '', project.exists ? '' : 'is-warn'].filter(Boolean).join(' ');
  return (
    <li className={classes} aria-current={active || undefined}>
      <div className="project-card-head">
        <Monogram name={project.name} size={40} />
        <div className="project-card-id">
          {renaming ? (
            <RenameForm initial={project.name} pending={rename.isPending} onSave={(name) => rename.mutate(name)} onCancel={() => setRenaming(false)} />
          ) : (
            <h2 className="project-card-name">
              <span className="ellipsis">{project.name}</span>
              {!project.exists && <Tag tone="warn">{t('work:projects.missing')}</Tag>}
            </h2>
          )}
          <span className="mono project-card-path ellipsis" title={project.path}>
            {project.path}
          </span>
        </div>
        <ProjectActions project={project} onRename={() => setRenaming(true)} onRemove={() => void askRemove()} onPurge={() => void askPurge()} />
      </div>
      <dl className="project-card-stats">
        <div className="project-stat">
          <dt className="section-label">{t('card.stats.chats')}</dt>
          <dd className="project-stat-value">{formatNumber(project.chatCount)}</dd>
        </div>
        <div className="project-stat">
          <dt className="section-label">{t('card.stats.worktrees')}</dt>
          <dd className="project-stat-value">{formatNumber(project.worktrees.length)}</dd>
        </div>
        <div className="project-stat project-stat-activity">
          <dt className="section-label">{t('card.stats.activity')}</dt>
          {live ? (
            <dd className="project-stat-value is-live">
              <StatusDot tone="active" live />
              {t('common:time.now')}
            </dd>
          ) : (
            <dd className="project-stat-value is-quiet" title={project.lastActivity ? formatDateTime(project.lastActivity) : undefined}>
              {sinceShort(project.lastActivity)}
            </dd>
          )}
        </div>
      </dl>
      <div className="project-card-actions">
        {project.exists ? (
          <Link to={`/chats/new?cwd=${encodeURIComponent(project.path)}`} className="btn btn-small project-card-new" aria-label={t('worktrees.newChatIn', { name: project.name })}>
            {t('worktrees.newChatHere')}
          </Link>
        ) : (
          <button type="button" className="btn btn-small project-card-new" disabled>
            {t('worktrees.newChatHere')}
          </button>
        )}
        <Link to={`/?project=${encodeURIComponent(project.id)}`} className="btn btn-small project-card-open" aria-label={t('card.openNamed', { name: project.name })}>
          {t('common:actions.open')}
        </Link>
      </div>
    </li>
  );
}

export function Projects() {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const narrow = useMediaQuery(NARROW);
  const [adding, setAdding] = useState<'import' | 'create' | null>(null);
  const { data, error, isLoading } = useProjects();
  const projects = data ?? [];
  // The card that stands out is the project the top bar has selected; with All projects none does
  const { projectId: activeId } = useProjectScope();
  // A project is live while a chat under it is working: that, and only that, gets the pinging dot
  const working = useChats({ state: 'working', origin: ['agentry', 'external', 'orchestration'] });
  const liveIds = new Set((working.data ?? []).flatMap((chat) => (chat.project ? [chat.project.id] : [])));
  // Candidates are always there to offer; the page decides how loudly, and only asks once it knows
  const candidates = useProjectCandidates(!isLoading);
  const offered = candidates.data ?? [];
  const first = !isLoading && projects.length === 0;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ProjectSort>('activity');
  const shown = projects.filter((project) => matchesText(search, [project.name, project.path])).sort(PROJECT_SORTERS[sort]);
  const importButton = (primary: boolean) => (
    <button className={primary ? 'btn btn-primary' : 'btn'} onClick={() => setAdding('import')}>
      <FolderPlus {...ICON_SM} />
      {t('page.importDirectory')}
    </button>
  );
  // One primary per zone: while the empty state offers the import, the header's copy steps back
  const emptyShown = first && offered.length === 0;

  return (
    <>
      <PageHeader
        title={t('work:projects.title')}
        subtitle={t('page.subtitle', { count: projects.length, n: formatNumber(projects.length) })}
        actions={
          adding === null && (
            <>
              <button className="btn" onClick={() => setAdding('create')}>
                <Plus {...ICON_SM} />
                {t('work:projects.newProject')}
              </button>
              {importButton(!emptyShown)}
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
          <Empty illustration="projects" size={narrow ? 'sm' : undefined} title={t('work:projects.empty')} action={adding === null ? importButton(true) : undefined}>
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
            <Empty illustration="no-results" size={narrow ? 'sm' : undefined} title={t('list.noneMatch')}>
              {t('list.noneMatchHint')}
            </Empty>
          ) : (
            <ul className="project-grid">
              {shown.map((project) => (
                <ProjectCard key={project.id} project={project} active={project.id === activeId} live={liveIds.has(project.id)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {offered.length > 0 && <Candidates candidates={offered} first={first} />}
    </>
  );
}
