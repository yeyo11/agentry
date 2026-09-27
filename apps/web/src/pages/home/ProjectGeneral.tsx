import type { Project, ProjectModule, WorkItemStatus } from '@agentry/shared';
import { WORK_ITEM_STATUSES } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError, api, keys, useProjects, useProjectSettings, useWorkItemBoard } from '../../api';
import { Sheet } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON_SM, WorkItemStatusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, Skeleton } from '../../components/ui';
import { useDirty } from '../../lib/dirty';
import { errorMessage, formatNumber } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { columnMeta, openCount } from '../../lib/work-items';
import { normalizePrefix, prefixProblem, PROJECT_MODULES, sameModules, toggleModule } from '../projects/model';
import { HiddenNote, ModuleCard, ModulesOffNote } from '../projects/parts';

type Limits = Partial<Record<WorkItemStatus, number>>;

const sameLimits = (a: Limits, b: Limits): boolean => WORK_ITEM_STATUSES.every((s) => a[s] === b[s]);

/** The limits that are set, as the phone's cell says them: "in progress 3 · in review 3". */
function useLimitsLine(limits: Limits): string {
  const { t } = useTranslation(['projects', 'tasks']);
  const set = WORK_ITEM_STATUSES.flatMap((s) => {
    const limit = limits[s];
    return limit === undefined ? [] : [`${t(`tasks:${columnMeta(s).label}`).toLocaleLowerCase()} ${formatNumber(limit)}`];
  });
  return set.length ? set.join(' · ') : t('general.noLimits');
}

function LimitFields({ limits, onChange }: { limits: Limits; onChange: (limits: Limits) => void }) {
  const { t } = useTranslation(['projects', 'tasks']);
  return (
    <div className="limit-grid">
      {WORK_ITEM_STATUSES.map((status) => {
        const label = t(`tasks:${columnMeta(status).label}`);
        return (
          <div key={status} className="limit-field">
            <span className="limit-label">
              <WorkItemStatusIcon status={status} decorative />
              {label}
            </span>
            {/* A plain field, as the reference draws it: empty is "no limit", and five steppers side by side would not fit */}
            <input
              className="mono"
              inputMode="numeric"
              value={limits[status] ?? ''}
              placeholder="–"
              aria-label={t('general.limitOf', { column: label })}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 3);
                const value = digits ? Number(digits) : undefined;
                onChange({ ...limits, [status]: value === 0 ? undefined : value });
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The part of a project's settings that is Agentry's own: its name, the prefix of its keys, its
 * modules and the limits of its board, saved together; and removing it. Claude Code's configuration
 * of the project follows it on the same tab.
 */
export function ProjectGeneral({ project }: { project: Project }) {
  const { t } = useTranslation(['projects', 'common', 'config']);
  const narrow = useMediaQuery(NARROW);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const settings = useProjectSettings(project.id);
  const projects = useProjects(false).data;
  // Read with the module off too: it says how much a switched-off board still keeps
  const board = useWorkItemBoard(project.id, {}).data;
  const saved = useMemo(
    () => ({ name: project.name, prefix: project.key, modules: project.modules, limits: settings.data?.board.columnLimits ?? {} }),
    [project.name, project.key, project.modules, settings.data],
  );
  const [name, setName] = useState(saved.name);
  const [prefix, setPrefix] = useState(saved.prefix);
  const [modules, setModules] = useState<ProjectModule[]>(saved.modules);
  const [limits, setLimits] = useState<Limits>(saved.limits);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // What another tab or an agent saved shows here, unless the person is editing that very field
  const [base, setBase] = useState(saved);
  useEffect(() => {
    if (name === base.name) setName(saved.name);
    if (prefix === base.prefix) setPrefix(saved.prefix);
    if (sameModules(modules, base.modules)) setModules(saved.modules);
    if (sameLimits(limits, base.limits)) setLimits(saved.limits);
    setBase(saved);
    // Only a change of what is saved re-seeds the form
  }, [saved]);

  const taken = useMemo(() => new Set((projects ?? []).filter((p) => p.id !== project.id).map((p) => p.key)), [projects, project.id]);
  const problem = prefix === saved.prefix ? null : prefixProblem(prefix, taken);
  const changed = {
    name: name.trim() !== saved.name,
    prefix: prefix !== saved.prefix,
    modules: !sameModules(modules, saved.modules),
    limits: settings.data !== undefined && !sameLimits(limits, saved.limits),
  };
  const dirty = changed.name || changed.prefix || changed.modules || changed.limits;
  useDirty('project', dirty);

  const save = useMutation({
    mutationFn: async () => {
      setKeyError(null);
      if (changed.name || changed.prefix || changed.modules) {
        try {
          await api.updateProject(project.id, {
            ...(changed.name ? { name: name.trim() } : {}),
            ...(changed.prefix ? { key: prefix } : {}),
            ...(changed.modules ? { modules } : {}),
          });
        } catch (error) {
          // A clash another project made since the page loaded: said in the field it is about
          if (changed.prefix && error instanceof ApiRequestError && /key/i.test(errorMessage(error))) setKeyError(errorMessage(error));
          throw error;
        }
      }
      if (changed.limits) {
        // Read again right before writing: the document is replaced whole, and the call above changed it
        const fresh = await api.projectSettings(project.id);
        await api.putProjectSettings(project.id, { ...fresh, board: { ...fresh.board, columnLimits: limits } });
      }
    },
    onSuccess: () => toast.success(t('general.saved')),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.projectSettings(project.id) });
    },
  });

  const discard = () => {
    setName(saved.name);
    setPrefix(saved.prefix);
    setModules(saved.modules);
    setLimits(saved.limits);
    setKeyError(null);
    save.reset();
  };

  const remove = useMutation({
    mutationFn: () => api.removeProject(project.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      toast.success(t('card.removed', { name: project.name }), t('card.removedHint'));
      navigate('/projects');
    },
    onError: (error) => toast.error(t('card.removeFailed'), error),
  });
  const askRemove = async () => {
    const ok = await confirm({
      title: t('card.removeTitle', { name: project.name }),
      body: t('card.removeBody', { count: project.chatCount, n: formatNumber(project.chatCount) }),
      confirmLabel: t('card.removeConfirm'),
    });
    if (ok) remove.mutate();
  };

  const limitsLine = useLimitsLine(limits);
  if (settings.isLoading) return <Skeleton rows={4} height={18} />;

  const total = board?.columns.reduce((sum, column) => sum + column.count, 0) ?? 0;
  const noteOf = (module: ProjectModule, on: boolean) => {
    if (module === 'board') {
      if (!board) return undefined;
      if (!on) return <HiddenNote empty={total === 0} />;
      return t('general.boardNote', { open: formatNumber(openCount(board) ?? 0), total: formatNumber(total) });
    }
    // Team, Documents and the journal hold nothing Agentry can count until orchestration 3
    return on ? undefined : <HiddenNote empty={!saved.modules.includes(module)} />;
  };
  const onCount = modules.length;
  const prefixHint = (
    <Trans
      t={t}
      i18nKey={prefix && prefix !== saved.prefix ? 'general.prefixHintChange' : 'general.prefixHint'}
      values={{ from: `${saved.prefix}-12`, to: `${prefix}-12` }}
      components={{ mono: <span className="mono" /> }}
    />
  );
  const prefixMessage = keyError ?? (problem ? t(`prefix.${problem}`, { prefix }) : null);

  const moduleCards = PROJECT_MODULES.map((module) => {
    const on = modules.includes(module);
    return <ModuleCard key={module} module={module} on={on} compact={narrow} note={noteOf(module, on)} onChange={(next) => setModules(toggleModule(modules, module, next))} />;
  });
  const offNote = (
    <ModulesOffNote>
      <Trans t={t} i18nKey={narrow ? 'modules.offMeansShort' : 'modules.offMeansLong'} components={{ strong: <strong /> }} />
    </ModulesOffNote>
  );
  const actions = (
    <div className="project-general-actions">
      {!narrow && (
        <button type="button" className="btn btn-quiet" disabled={!dirty || save.isPending} onClick={discard}>
          {t('general.discard')}
        </button>
      )}
      <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending || problem !== null || !name.trim()} onClick={() => save.mutate()}>
        {save.isPending ? t('general.saving') : t('general.save')}
      </button>
    </div>
  );
  const error = !keyError && <ErrorBox error={save.error} title={t('general.saveFailed')} />;
  const removeButton = (
    <button type="button" className="btn" disabled={remove.isPending} onClick={() => void askRemove()}>
      <X {...ICON_SM} />
      {t('card.remove')}
    </button>
  );

  if (narrow) {
    return (
      <div className="project-general project-general-phone">
        <section className="settings-cells-group">
          <h2 className="section-label settings-cells-label">{t('general.title')}</h2>
          <div className="card settings-cells project-general-cells">
            <label className="project-general-cell">
              <span className="project-general-cell-k">{t('general.name')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="project-general-cell">
              <span className="project-general-cell-k">{t('general.prefixShort')}</span>
              <input className={`mono ${prefixMessage ? 'is-invalid' : ''}`} value={prefix} aria-invalid={!!prefixMessage} onChange={(e) => setPrefix(normalizePrefix(e.target.value))} />
            </label>
          </div>
          {prefixMessage ? (
            <span className="field-error" role="alert">
              {prefixMessage}
            </span>
          ) : (
            <span className="field-hint">{prefixHint}</span>
          )}
        </section>
        <section className="settings-cells-group">
          <h2 className="section-label settings-cells-label">{t('general.modules')}</h2>
          <div className="card settings-cells project-module-cells">{moduleCards}</div>
          {offNote}
        </section>
        {modules.includes('board') && (
          <>
            <button type="button" className="settings-cell project-limits-cell" onClick={() => setLimitsOpen(true)}>
              <span className="settings-cell-name project-limits-text">
                <span>{t('general.boardLimits')}</span>
                <span className="mono small muted">{limitsLine}</span>
              </span>
              <ChevronRight {...ICON_SM} className="settings-cell-chevron" />
            </button>
            <Sheet open={limitsOpen} onOpenChange={setLimitsOpen} title={t('general.boardLimits')} side="bottom">
              <p className="small muted">{t('general.limitsHint')}</p>
              <LimitFields limits={limits} onChange={setLimits} />
            </Sheet>
          </>
        )}
        <section className="card project-remove">
          <h2>{t('general.removeTitle')}</h2>
          <p className="small muted">{t('general.removeBody')}</p>
          {removeButton}
        </section>
        {error}
        <div className="project-general-foot">{actions}</div>
      </div>
    );
  }

  return (
    <div className="project-general">
      <div className="project-general-grid">
        <div className="project-general-col">
          <section className="card project-general-card">
            <h2>{t('general.title')}</h2>
            <label className="form-row">
              <span className="section-label">{t('general.name')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="form-row project-prefix">
              <span className="section-label">{t('general.prefix')}</span>
              <input className={`mono ${prefixMessage ? 'is-invalid' : ''}`} value={prefix} aria-invalid={!!prefixMessage} onChange={(e) => setPrefix(normalizePrefix(e.target.value))} />
              {prefixMessage ? (
                <span className="field-error" role="alert">
                  {prefixMessage}
                </span>
              ) : (
                <span className="field-hint">{prefixHint}</span>
              )}
            </label>
            <div className="form-row">
              <span className="section-label">{t('general.directory')}</span>
              <span className="mono small break">{project.path}</span>
            </div>
          </section>
          {modules.includes('board') && (
            <section className="card project-general-card">
              <h2>{t('modules.board.name')}</h2>
              <p className="small muted">{t('general.limitsHint')}</p>
              <LimitFields limits={limits} onChange={setLimits} />
            </section>
          )}
          <section className="card project-remove">
            <div className="project-remove-text">
              <h2>{t('general.removeTitle')}</h2>
              <p className="small muted">{t('general.removeBody')}</p>
            </div>
            {removeButton}
          </section>
        </div>
        <section className="card project-general-card project-modules">
          <div className="project-modules-head">
            <h2>{t('general.modules')}</h2>
            <span className="mono small muted">{t('general.modulesOn', { n: formatNumber(onCount), total: formatNumber(PROJECT_MODULES.length) })}</span>
          </div>
          {moduleCards}
          {offNote}
        </section>
      </div>
      {error}
      {actions}
    </div>
  );
}
