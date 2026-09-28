import type { Project, ProjectTemplateId } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiRequestError, keys, useProjects, useProjectTemplates } from '../../api';
import { ICON, ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, usePageTitle } from '../../components/ui';
import { errorMessage } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { assistantPath, proposesByDefault } from '../assistant/model';
import { PROJECT_MODULES, sortModules } from './model';
import { ModulesOffNote } from './parts';
import { STEPS, useWizard, type Draft, type Step } from './wizard';
import { ModuleChoice, OriginFields, ProposeSwitch, Section, Summary, TemplateChoice } from './wizard-parts';

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
