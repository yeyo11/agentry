import type { ProjectTemplate, ProjectTemplateId } from '@agentry/shared';
import { WORK_ITEM_TYPES } from '@agentry/shared';
import { Check, Folder, GitBranch, MessageCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Combobox, Switch } from '@agentry/ui/components/controls';
import { ICON, ICON_SM, Monogram } from '@agentry/ui/components/icons';
import { WorkItemKey, WorkItemTypeIcon } from '../../components/work-item-icons';
import { Segmented } from '@agentry/ui/components/ui';
import { formatNumber } from '@agentry/ui/lib/format';
import { columnMeta } from '../../lib/work-items';
import { limitedColumns, normalizePrefix, PROJECT_MODULES, TEMPLATE_ORDER, toggleModule } from './model';
import { ModuleCard, TemplateCard } from './parts';
import type { Draft, Wizard } from './wizard';

export function OriginFields({ draft, set, wizard, narrow }: { draft: Draft; set: (patch: Partial<Draft>) => void; wizard: Wizard; narrow: boolean }) {
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

export function TemplateChoice({ draft, templates, choose }: { draft: Draft; templates: ProjectTemplate[] | undefined; choose: (id: ProjectTemplateId) => void }) {
  const { t } = useTranslation('projects');
  return (
    <div className="template-grid" role="radiogroup" aria-label={t('wizard.steps.template')}>
      {TEMPLATE_ORDER.map((id) => (
        <TemplateCard key={id} id={id} modules={templates?.find((tpl) => tpl.id === id)?.modules ?? []} checked={draft.template === id} onSelect={() => choose(id)} />
      ))}
    </div>
  );
}

export function ModuleChoice({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
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

export function Summary({ draft, wizard, onChange }: { draft: Draft; wizard: Wizard; onChange?: () => void }) {
  const { t } = useTranslation(['projects', 'tasks']);
  const board = draft.modules.includes('board');
  const types = wizard.template?.board.types ?? [];
  const limits = limitedColumns(wizard.template?.board);
  const team = wizard.template?.team ?? [];
  return (
    <>
      <div className="summary-project">
        <Monogram name={wizard.name || '?'} size={40} project />
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
export function ProposeSwitch({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
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
export function Section({ n, title, hint, aside, children }: { n: number; title: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
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
