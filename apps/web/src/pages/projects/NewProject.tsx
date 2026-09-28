import type { Project, ProjectModule, ProjectTemplate, ProjectTemplateId } from '@agentry/shared';
import { WORK_ITEM_TYPES } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Folder, GitBranch, MessageCircle, Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiRequestError, keys, useProjectCandidates, useProjects, useProjectTemplates } from '../../api';
import { Combobox, Switch } from '../../components/controls';
import { ICON, ICON_SM, Monogram, WorkItemKey, WorkItemTypeIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, Segmented, usePageTitle } from '../../components/ui';
import { errorMessage, formatNumber } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { columnMeta } from '../../lib/work-items';
import { assistantPath, proposesByDefault } from '../assistant/model';
import { deriveKeyPrefix, folderNameFor, limitedColumns, normalizePrefix, prefixProblem, PROJECT_MODULES, sortModules, TEMPLATE_ORDER, toggleModule } from './model';
import { ModuleCard, ModulesOffNote, TemplateCard } from './parts';

type Source = 'local' | 'git';
const STEPS = ['origin', 'template', 'modules', 'summary'] as const;
type Step = (typeof STEPS)[number];

/** The last part of a path or a repository URL, which is what the project is called unless renamed. */
function baseName(value: string): string {
  const parts = value.trim().replace(/[/\\]+$/, '').replace(/\.git$/, '').split(/[/\\:]/);
  return parts[parts.length - 1] ?? '';
}

interface Draft {
  source: Source;
  name: string;
  path: string;
  gitUrl: string;
  /** The prefix the person typed; null while it follows the name */
  prefix: string | null;
  template: ProjectTemplateId;
  modules: ProjectModule[];
  /** Hand the new project to the assistant, which proposes its team, resources and first tasks */
  propose: boolean;
}

/** Everything the wizard's screens read from one draft, worked out once. */
function useWizard(draft: Draft, templates: ProjectTemplate[] | undefined, projects: Project[] | undefined) {
  const candidates = useProjectCandidates().data;
  const taken = useMemo(() => new Set((projects ?? []).map((p) => p.key)), [projects]);
  const name = draft.name.trim() || baseName(draft.source === 'git' ? draft.gitUrl : draft.path);
  const prefix = draft.prefix ?? deriveKeyPrefix(name, taken);
  const problem = draft.prefix === null ? null : prefixProblem(prefix, taken);
  const template = templates?.find((tpl) => tpl.id === draft.template);
  const candidate = draft.source === 'local' ? candidates?.find((c) => c.path === draft.path.trim()) : undefined;
  const where = draft.source === 'git' ? draft.gitUrl.trim() : draft.path.trim();
  // A new directory (created or cloned) is named after the project, as far as a folder name allows;
  // the project keeps the name as typed. Importing takes the directory as it is.
  const makesFolder = draft.source === 'git' || !draft.path.trim();
  const folder = makesFolder ? folderNameFor(name) : null;
  const folderProblem = makesFolder && name && !folder ? 'empty' : null;
  // Creating needs a name; importing takes the directory's; cloning needs its URL
  const originReady = draft.source === 'git' ? !!draft.gitUrl.trim() && !!name : !!name;
  return {
    candidates: candidates ?? [],
    name,
    prefix,
    problem,
    template,
    candidate,
    where,
    folder,
    folderProblem,
    ready: originReady && problem === null && folderProblem === null,
  };
}

type Wizard = ReturnType<typeof useWizard>;

function OriginFields({ draft, set, wizard, narrow }: { draft: Draft; set: (patch: Partial<Draft>) => void; wizard: Wizard; narrow: boolean }) {
  const { t } = useTranslation('projects');
  const sourceSwitch = (
    <Segmented
      label={t('wizard.source')}
      value={draft.source}
      onChange={(source) => set({ source })}
      options={[
        { value: 'local', label: narrow ? <><Folder {...ICON_SM} /> {t('wizard.local')}</> : t('wizard.local') },
        { value: 'git', label: narrow ? <><GitBranch {...ICON_SM} /> {t('wizard.git')}</> : t('wizard.git') },
      ]}
    />
  );
  const keys = (
    <Trans t={t} i18nKey="wizard.keysHint" values={{ a: `${wizard.prefix}-1`, b: `${wizard.prefix}-2` }} components={{ mono: <span className="mono" /> }} />
  );
  const prefixError = wizard.problem && <span className="field-error" role="alert">{t(`prefix.${wizard.problem}`, { prefix: wizard.prefix })}</span>;
  return (
    <div className="wizard-origin">
      <label className="form-row wizard-name">
        <span className="section-label">{t('wizard.name')}</span>
        <input
          className={wizard.folderProblem ? 'is-invalid' : undefined}
          value={draft.name}
          placeholder={wizard.name || t('wizard.namePlaceholder')}
          aria-invalid={wizard.folderProblem !== null}
          onChange={(e) => set({ name: e.target.value })}
        />
        {/* Said while typing, not after "Create project": the folder is the one thing a name must fit */}
        {wizard.folderProblem ? (
          <span className="field-error" role="alert">
            {t('wizard.folderEmpty')}
          </span>
        ) : (
          wizard.folder &&
          wizard.folder !== wizard.name && (
            <span className="form-hint">
              <Trans t={t} i18nKey="wizard.folderHint" values={{ folder: wizard.folder }} components={{ mono: <span className="mono" /> }} />
            </span>
          )
        )}
      </label>
      <div className="form-row wizard-where">
        <span className="wizard-where-head">
          <span className="section-label">{t('wizard.directory')}</span>
          {!narrow && sourceSwitch}
        </span>
        {narrow && sourceSwitch}
        {draft.source === 'local' ? (
          <Combobox
            aria-label={t('wizard.directory')}
            placeholder={t('wizard.directoryPlaceholder')}
            value={draft.path}
            onChange={(path) => set({ path })}
            options={wizard.candidates.map((c) => ({ value: c.path, label: c.name, hint: t('importForm.candidateHint', { count: c.chatCount, n: formatNumber(c.chatCount), path: c.path }) }))}
          />
        ) : (
          <input className="mono" aria-label={t('wizard.git')} value={draft.gitUrl} placeholder="https://github.com/owner/repo.git" onChange={(e) => set({ gitUrl: e.target.value })} />
        )}
      </div>
      <label className="form-row wizard-prefix">
        <span className="section-label">{t('wizard.prefix')}</span>
        <input
          className={`mono ${wizard.problem ? 'is-invalid' : ''}`}
          value={wizard.prefix}
          aria-invalid={wizard.problem !== null}
          onChange={(e) => set({ prefix: normalizePrefix(e.target.value) })}
        />
        {narrow && (prefixError ?? <span className="form-hint">{keys}</span>)}
      </label>
      {!narrow && prefixError}
      <p className={narrow ? 'wizard-origin-note' : 'form-hint wizard-origin-hint'}>
        {narrow && <MessageCircle {...ICON} />}
        <span>
          {draft.source === 'git'
            ? t('wizard.gitHint')
            : wizard.candidate
              ? t('wizard.candidateHint', { count: wizard.candidate.chatCount, n: formatNumber(wizard.candidate.chatCount) })
              : draft.path.trim()
                ? t('wizard.importHint')
                : t('wizard.emptyHint')}{' '}
          {!narrow && keys}
        </span>
      </p>
    </div>
  );
}

function TemplateChoice({ draft, templates, choose }: { draft: Draft; templates: ProjectTemplate[] | undefined; choose: (id: ProjectTemplateId) => void }) {
  const { t } = useTranslation('projects');
  return (
    <div className="template-grid" role="radiogroup" aria-label={t('wizard.steps.template')}>
      {TEMPLATE_ORDER.map((id) => (
        <TemplateCard key={id} id={id} modules={templates?.find((tpl) => tpl.id === id)?.modules ?? []} checked={draft.template === id} onSelect={() => choose(id)} />
      ))}
    </div>
  );
}

function ModuleChoice({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
  return (
    <div className="module-grid">
      {PROJECT_MODULES.map((module) => (
        <ModuleCard key={module} module={module} on={draft.modules.includes(module)} onChange={(on) => set({ modules: toggleModule(draft.modules, module, on) })} />
      ))}
    </div>
  );
}

function SummaryRow({ label, children, top = false }: { label: string; children: ReactNode; top?: boolean }) {
  return (
    <div className={`summary-row ${top ? 'summary-row-top' : ''}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Summary({ draft, wizard, onChange }: { draft: Draft; wizard: Wizard; onChange?: () => void }) {
  const { t } = useTranslation(['projects', 'tasks']);
  const board = draft.modules.includes('board');
  const types = wizard.template?.board.types ?? [];
  const limits = limitedColumns(wizard.template?.board);
  const team = wizard.template?.team ?? [];
  return (
    <>
      <div className="summary-project">
        <Monogram name={wizard.name || '?'} size={40} />
        <span className="summary-project-id">
          <strong className="break">{wizard.name || t('wizard.unnamed')}</strong>
          <span className="mono small muted ellipsis" title={wizard.where || undefined}>
            {draft.source === 'git' || !wizard.where ? `${wizard.where ? `${wizard.where} → ` : ''}${wizard.folder ? `${wizard.folder}/` : t('wizard.inWorkspace')}` : wizard.where}
          </span>
        </span>
        {onChange && (
          <button type="button" className="btn btn-small btn-quiet" onClick={onChange}>
            {t('wizard.change')}
          </button>
        )}
      </div>
      <dl className="summary-rows">
        <SummaryRow label={t('wizard.steps.template')}>{t(`templates.${draft.template}.name`)}</SummaryRow>
        <SummaryRow label={t('wizard.summaryKeys')}>
          <WorkItemKey value={`${wizard.prefix}-1`} boxed />
        </SummaryRow>
        <SummaryRow label={t('wizard.steps.modules')} top>
          <ul className="summary-modules">
            {PROJECT_MODULES.map((module) => {
              const on = draft.modules.includes(module);
              return (
                <li key={module} className={on ? 'is-on' : ''}>
                  {on ? <Check {...ICON_SM} className="text-ok" /> : <X {...ICON_SM} />}
                  {on ? t(`modules.${module}.name`) : t('wizard.moduleOff', { name: t(`modules.${module}.name`) })}
                </li>
              );
            })}
          </ul>
        </SummaryRow>
        {board && wizard.template && (
          <>
            <SummaryRow label={t('wizard.summaryTypes')}>
              <span className="summary-types">
                {types.map((type) => (
                  <WorkItemTypeIcon key={type} type={type} />
                ))}
                <span className="small muted">
                  {types.length === WORK_ITEM_TYPES.length ? t('wizard.allTypes') : types.map((type) => t(`tasks:type.${type}`)).join(', ')}
                </span>
              </span>
            </SummaryRow>
            <SummaryRow label={t('wizard.summaryLimits')}>
              <span className="mono small">
                {limits.length
                  ? limits.map(({ status, limit }) => `${t(`tasks:${columnMeta(status).label}`).toLocaleLowerCase()} ${formatNumber(limit)}`).join(' · ')
                  : t('wizard.noLimits')}
              </span>
            </SummaryRow>
          </>
        )}
        {draft.modules.includes('team') && wizard.template && (
          <SummaryRow label={t('modules.team.name')} top>
            <span className="summary-team">
              <span>{team.length ? t('wizard.teamRoles', { count: team.length, n: formatNumber(team.length) }) : t('wizard.noTeam')}</span>
              <span className="small muted">{t('wizard.teamHint')}</span>
            </span>
          </SummaryRow>
        )}
      </dl>
    </>
  );
}

/** Whether the new project goes to the assistant, which proposes its team, resources and first tasks. */
function ProposeSwitch({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
  const { t } = useTranslation('assistant');
  return (
    <Switch checked={draft.propose} onChange={(propose) => set({ propose })} className="check wizard-propose">
      <span className="wizard-propose-text">
        <span className="wizard-propose-title">{t('wizard.propose')}</span>
        <span className="small muted">{t('wizard.proposeHint')}</span>
      </span>
    </Switch>
  );
}

/** A numbered heading of the desktop wizard: the four parts are one page there, in order. */
function Section({ n, title, hint, aside, children }: { n: number; title: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="wizard-section" aria-label={title}>
      <div className="wizard-section-head">
        <span className="wizard-step-n">{n}</span>
        <h2>{title}</h2>
        {hint && <span className="small muted wizard-section-hint">{hint}</span>}
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * `/projects/new`: a project from a directory on disk, a git URL or nothing (a new directory in the
 * workspace), with a template that preselects its modules and the switches to change them. A desktop
 * shows the four parts on one page with the summary beside them; a phone walks them one by one.
 * `?path=` opens it on a directory to import, as the Projects page's candidates do.
 */
export function NewProject() {
  const { t } = useTranslation(['projects', 'work', 'common', 'assistant']);
  usePageTitle(t('work:projects.newProject'));
  const narrow = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const templates = useProjectTemplates().data;
  const projects = useProjects(false).data;
  const [draft, setDraft] = useState<Draft>(() => ({
    source: params.get('source') === 'git' ? 'git' : 'local',
    name: '',
    path: params.get('path') ?? '',
    gitUrl: '',
    prefix: null,
    template: 'software',
    // Until the templates arrive, the software template's modules: everything
    modules: [...PROJECT_MODULES],
    propose: proposesByDefault('software'),
  }));
  const [step, setStep] = useState<Step>('origin');
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const wizard = useWizard(draft, templates, projects);
  const choose = (id: ProjectTemplateId) => set({ template: id, modules: sortModules(templates?.find((tpl) => tpl.id === id)?.modules ?? []), propose: proposesByDefault(id) });

  const create = useMutation({
    mutationFn: async () => {
      const setup = { template: draft.template, modules: draft.modules };
      const folder = wizard.folder ?? wizard.name;
      let project: Project;
      try {
        project =
          draft.source === 'git'
            ? await api.createProject({ name: folder, gitUrl: draft.gitUrl.trim(), ...setup })
            : draft.path.trim()
              ? await api.importProject({ path: draft.path.trim(), ...(draft.name.trim() ? { name: draft.name.trim() } : {}), ...setup })
              : await api.createProject({ name: folder, ...setup });
      } catch (error) {
        // The one refusal a person can fix from here, said in their words rather than the server's
        if (wizard.folder && error instanceof ApiRequestError && /already exists/.test(errorMessage(error))) throw new Error(t('wizard.folderTaken', { folder: wizard.folder }));
        throw error;
      }
      // The directory holds what a folder name can; the project is called as the person wrote it.
      // The API derives a prefix of its own; only one the person typed is worth sending.
      const rename = project.name !== wizard.name ? wizard.name : null;
      const key = draft.prefix !== null && draft.prefix !== project.key ? draft.prefix : null;
      if (rename || key) {
        try {
          return await api.updateProject(project.id, { ...(rename ? { name: rename } : {}), ...(key ? { key } : {}) });
        } catch (error) {
          toast.error(t(key ? 'wizard.keyFailed' : 'wizard.renameFailed'), error);
        }
      }
      return project;
    },
    onSuccess: async (project) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      void queryClient.invalidateQueries({ queryKey: keys.overview });
      toast.success(t('wizard.created', { name: project.name }));
      if (!draft.propose) {
        navigate(`/?project=${encodeURIComponent(project.id)}`);
        return;
      }
      // The project exists whatever the assistant does: a run that cannot start still leads to its
      // page, which offers to ask again
      try {
        const run = await api.startAssistantRun(project.id, { kind: 'project' });
        queryClient.setQueryData(keys.assistantRun(run.id), run);
      } catch (error) {
        toast.error(t('assistant:wizard.startFailed'), error);
      }
      navigate(assistantPath(project.id));
    },
  });

  const createButton = (
    <button type="button" className="btn btn-primary btn-tall wizard-create" disabled={!wizard.ready || create.isPending} onClick={() => create.mutate()}>
      <Plus {...ICON} />
      {create.isPending ? (draft.source === 'git' ? t('work:projects.cloning') : t('work:projects.creating')) : t('wizard.create')}
    </button>
  );
  const error = <ErrorBox error={create.error} title={t('work:projects.createFailed')} />;

  if (narrow) {
    const at = STEPS.indexOf(step);
    const go = (by: number) => setStep(STEPS[at + by] ?? step);
    return (
      <div className="wizard wizard-phone">
        <header className="wizard-phone-head">
          <Link to="/projects" className="icon-btn" aria-label={t('wizard.close')}>
            <X {...ICON} />
          </Link>
          <div className="wizard-phone-title">
            <h1>{t('work:projects.newProject')}</h1>
            <span className="mono small muted ellipsis">
              {t('wizard.stepOf', { n: at + 1, total: STEPS.length })}
              {wizard.name ? ` · ${wizard.name}` : ''}
            </span>
          </div>
        </header>
        <ol className="wizard-steps" aria-label={t('wizard.stepsLabel')}>
          {STEPS.map((id, i) => (
            <li key={id} className={`wizard-step ${i === at ? 'is-on' : i < at ? 'is-done' : ''}`} aria-current={i === at ? 'step' : undefined}>
              <span className="wizard-step-name">
                {i < at ? <Check {...ICON_SM} /> : <span className="mono">{i + 1}</span>}
                {t(`wizard.steps.${id}`)}
              </span>
            </li>
          ))}
        </ol>
        <div className="wizard-phone-body">
          {step === 'origin' && (
            <>
              <h2>{t('wizard.steps.origin')}</h2>
              <OriginFields draft={draft} set={set} wizard={wizard} narrow />
            </>
          )}
          {step === 'template' && (
            <>
              <h2>{t('wizard.chooseTemplate')}</h2>
              <p className="muted">{t('wizard.templateHint')}</p>
              <TemplateChoice draft={draft} templates={templates} choose={choose} />
            </>
          )}
          {step === 'modules' && (
            <>
              <h2>{t('wizard.steps.modules')}</h2>
              <p className="muted">{t('wizard.modulesHintPhone', { template: t(`templates.${draft.template}.name`) })}</p>
              <ModuleChoice draft={draft} set={set} />
              <ModulesOffNote>{t('modules.offMeansShort')}</ModulesOffNote>
            </>
          )}
          {step === 'summary' && (
            <>
              <h2>{t('wizard.steps.summary')}</h2>
              <div className="card wizard-summary">
                <Summary draft={draft} wizard={wizard} onChange={() => setStep('origin')} />
              </div>
              <ProposeSwitch draft={draft} set={set} />
              {error}
            </>
          )}
        </div>
        <footer className="wizard-phone-foot">
          {at === 0 ? (
            <Link to="/projects" className="btn btn-tall">
              {t('common:actions.cancel')}
            </Link>
          ) : (
            <button type="button" className="btn btn-tall" onClick={() => go(-1)}>
              {t('wizard.back')}
            </button>
          )}
          {step === 'summary' ? (
            createButton
          ) : (
            <button type="button" className="btn btn-primary btn-tall" disabled={step === 'origin' && !wizard.ready} onClick={() => go(1)}>
              {t('wizard.next')}
            </button>
          )}
        </footer>
      </div>
    );
  }

  return (
    <div className="wizard">
      <header className="page-header wizard-head">
        <Link to="/projects" className="btn wizard-back" aria-label={t('wizard.backToProjects')}>
          <ChevronLeft {...ICON} />
        </Link>
        <div className="page-header-text">
          <h1>{t('work:projects.newProject')}</h1>
          <div className="muted">{t('wizard.subtitle')}</div>
        </div>
      </header>
      <div className="wizard-layout">
        <div className="wizard-main">
          <Section n={1} title={t('wizard.steps.origin')}>
            <div className="card wizard-origin-card">
              <OriginFields draft={draft} set={set} wizard={wizard} narrow={false} />
            </div>
          </Section>
          <Section n={2} title={t('wizard.steps.template')} hint={t('wizard.templateHint')}>
            <TemplateChoice draft={draft} templates={templates} choose={choose} />
          </Section>
          <Section
            n={3}
            title={t('wizard.steps.modules')}
            hint={t('wizard.modulesHint')}
            aside={
              <span className="wizard-section-aside small muted">
                <ModulesOffNote>{t('modules.offMeansBrief')}</ModulesOffNote>
              </span>
            }
          >
            <ModuleChoice draft={draft} set={set} />
          </Section>
        </div>
        <aside className="card wizard-summary" aria-label={t('wizard.steps.summary')}>
          <div className="wizard-section-head">
            <span className="wizard-step-n">4</span>
            <h2>{t('wizard.steps.summary')}</h2>
          </div>
          <Summary draft={draft} wizard={wizard} />
          <ProposeSwitch draft={draft} set={set} />
          {error}
          <div className="wizard-summary-actions">
            {createButton}
            <Link to="/projects" className="btn btn-quiet">
              {t('common:actions.cancel')}
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
