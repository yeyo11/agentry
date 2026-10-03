import type { LimitAction, Project, ProviderId, ProviderStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useProjectSettings } from '../../../api';
import { NumberInput, Sheet } from '@agentry/ui/components/controls';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Segmented, Skeleton } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { useDirty } from '../../../lib/dirty';
import { stateLabelKey } from '../../../lib/provider-state';
import { moveBy, orderedIds } from '../../../lib/provider-settings';
import { useProviders } from '../../../lib/providers';
import { ACTIONS, MOVES, WAIT_HOURS, clampInt, projectProvidersOf, rotationOf, type OnLimit } from './rotation';

/** What a project sets of its own; a missing field inherits the global one. */
interface Draft {
  /** Null inherits the global order */
  order: ProviderId[] | null;
  action?: LimitAction;
  /** Not offered here: kept as the project has it, so a save does not drop what the API wrote */
  allowed?: LimitAction[];
  maxWaitHours?: number;
  maxMoves?: number;
}

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A project's Providers override: the order its work picks providers in (a provider left out never
 * gets this project's work) and, for what happens at a limit, the action, the longest wait and the
 * moves per piece of work, each showing the global value until it is changed. The model mapping is
 * global only. Like Decisions, it saves on its own button and replaces `providers` in the project's
 * settings, read again right before writing.
 */
export function ProjectProviders({ project }: { project: Project }) {
  const { t } = useTranslation(['providers', 'projects']);
  const narrow = useMediaQuery(NARROW);
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useProjectSettings(project.id);
  const statuses = useProviders();
  const global = useQuery({ queryKey: keys.providerSettings, queryFn: () => api.providerSettings() });

  const saved = useMemo<Draft>(() => {
    const own = settings.data?.providers;
    return {
      order: own?.order ?? null,
      ...(own?.onLimit?.action !== undefined ? { action: own.onLimit.action } : {}),
      ...(own?.onLimit?.allowed !== undefined ? { allowed: own.onLimit.allowed } : {}),
      ...(own?.onLimit?.maxWaitHours !== undefined ? { maxWaitHours: own.onLimit.maxWaitHours } : {}),
      ...(own?.onLimit?.maxMoves !== undefined ? { maxMoves: own.onLimit.maxMoves } : {}),
    };
  }, [settings.data]);
  const [edit, setEdit] = useState<{ base: Draft; next: Draft } | null>(null);
  // What was saved elsewhere shows unless the person edited: an edit made on an older document is dropped
  const draft = edit && edit.base === saved ? edit.next : saved;
  const dirty = !sameDraft(draft, saved);
  useDirty('project-providers', dirty);
  const [open, setOpen] = useState(false);
  const change = (patch: Partial<Draft>) => setEdit({ base: saved, next: { ...draft, ...patch } });
  // A field handed back to the global is dropped, not set to the same value
  const reset = (field: 'action' | 'maxWaitHours' | 'maxMoves') => {
    const { [field]: _gone, ...rest } = draft;
    setEdit({ base: saved, next: rest });
  };

  const save = useMutation({
    mutationFn: async () => {
      // The document is replaced whole: read it again right before writing
      const fresh = await api.projectSettings(project.id);
      const { providers: _previous, ...rest } = fresh;
      const onLimit: Partial<OnLimit> = {};
      if (draft.action !== undefined) onLimit.action = draft.action;
      if (draft.allowed !== undefined) onLimit.allowed = draft.allowed;
      if (draft.maxWaitHours !== undefined) onLimit.maxWaitHours = draft.maxWaitHours;
      if (draft.maxMoves !== undefined) onLimit.maxMoves = draft.maxMoves;
      const providers = projectProvidersOf(draft.order, onLimit);
      return api.putProjectSettings(project.id, providers ? { ...rest, providers } : rest);
    },
    onSuccess: () => {
      setEdit(null);
      toast.success(t('project.saved'));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.projectSettings(project.id) }),
  });

  if (settings.isLoading || global.isLoading || statuses.isLoading) return <Skeleton rows={4} height={18} />;
  if (!global.data || !statuses.data) return <ErrorBox error={global.error ?? statuses.error} />;

  const globalOrder = orderedIds(statuses.data, global.data);
  const globalOn = rotationOf(global.data).onLimit;
  const byId = new Map(statuses.data.map((s) => [s.id, s]));
  const own = draft.order;
  const outside = globalOrder.filter((id) => own !== null && !own.includes(id));
  const action = draft.action ?? globalOn.action;
  const differing = [own !== null, draft.action !== undefined, draft.maxWaitHours !== undefined, draft.maxMoves !== undefined].filter(Boolean).length;

  const row = (id: ProviderId, at: number, last: number) => {
    const status = byId.get(id);
    if (!status || own === null) return null;
    return (
      <div className="prov-order-row" key={id}>
        <span className="prov-order-text">
          <span>{status.label}</span>
          <span className="prov-order-sub mono">{t('providers:default.positionState', { position: at + 1, state: t(`providers:${stateLabelKey(status.state)}`) })}</span>
        </span>
        <button type="button" className="icon-btn" aria-label={t('providers:order.up', { name: status.label })} disabled={at === 0} onClick={() => change({ order: moveBy(own, id, -1) })}>
          <ChevronUp {...ICON} />
        </button>
        <button type="button" className="icon-btn" aria-label={t('providers:order.down', { name: status.label })} disabled={at === last} onClick={() => change({ order: moveBy(own, id, 1) })}>
          <ChevronDown {...ICON} />
        </button>
        <button type="button" className="icon-btn" aria-label={t('providers:project.remove', { name: status.label })} onClick={() => change({ order: own.filter((x) => x !== id) })}>
          <X {...ICON} />
        </button>
      </div>
    );
  };
  const outRow = (id: ProviderId, status: ProviderStatus | undefined) =>
    status && (
      <div className="prov-order-row" key={id}>
        <span className="prov-order-text">
          <span className="muted">{status.label}</span>
          <span className="prov-order-sub mono">{t(`providers:${stateLabelKey(status.state)}`)}</span>
        </span>
        <button type="button" className="btn btn-small" onClick={() => own && change({ order: [...own, id] })}>
          {t('providers:project.add')}
        </button>
      </div>
    );

  /** One field of `onLimit`: what the project set, or the global value it inherits, and the way back. */
  const inherited = (field: 'maxWaitHours' | 'maxMoves', input: React.ReactNode, globalText: string) => (
    <div className="ov-field">
      <div className="rot-col">
        <span className="rot-name">{t(`providers:onLimit.${field === 'maxWaitHours' ? 'maxWait' : 'maxMoves'}.label`)}</span>
        <span className="mono small muted">{draft[field] === undefined ? t('providers:project.inherited', { global: globalText }) : t('providers:project.global', { global: globalText })}</span>
      </div>
      <div className="rot-line">
        {input}
        {draft[field] !== undefined && (
          <button type="button" className="btn prov-quiet btn-small" onClick={() => reset(field)}>
            {t('providers:project.useGlobal')}
          </button>
        )}
      </div>
    </div>
  );

  const body = (
    <>
      <div className="ov-block">
        <span className="section-label">{t('providers:project.order')}</span>
        <Segmented
          label={t('providers:project.orderAria')}
          value={own === null ? 'global' : 'own'}
          onChange={(v) => change({ order: v === 'global' ? null : [...globalOrder] })}
          options={[
            { value: 'global', label: t('providers:project.useGlobal') },
            { value: 'own', label: t('providers:project.own') },
          ]}
        />
        {own === null ? (
          <span className="form-hint">{t('providers:project.orderGlobal', { order: globalOrder.map((id) => byId.get(id)?.label ?? id).join(' → ') })}</span>
        ) : (
          <>
            <div className="card">{own.map((id, at) => row(id, at, own.length - 1))}</div>
            {outside.length > 0 && (
              <>
                <span className="section-label">{t('providers:project.outside')}</span>
                <div className="card">{outside.map((id) => outRow(id, byId.get(id)))}</div>
              </>
            )}
            <span className="form-hint">{t('providers:project.outsideHint')}</span>
          </>
        )}
      </div>
      <div className="ov-block">
        <span className="section-label">{t('providers:onLimit.title')}</span>
        <div className="ov-field">
          <div className="rot-col">
            <span className="rot-name">{t('providers:onLimit.action.label')}</span>
            <span className="mono small muted">{draft.action === undefined ? t('providers:project.inherited', { global: t(`providers:onLimit.action.${globalOn.action}.label`) }) : t('providers:project.global', { global: t(`providers:onLimit.action.${globalOn.action}.label`) })}</span>
          </div>
          <div className="rot-line">
            <Segmented
              label={t('providers:project.actionAria')}
              value={action}
              className={draft.action === undefined ? 'is-inherited' : undefined}
              onChange={(a) => change({ action: a })}
              options={ACTIONS.map((a) => ({ value: a, label: t(`providers:onLimit.action.${a}.label`) }))}
            />
            {draft.action !== undefined && (
              <button type="button" className="btn prov-quiet btn-small" onClick={() => reset('action')}>
                {t('providers:project.useGlobal')}
              </button>
            )}
          </div>
        </div>
        {inherited(
          'maxWaitHours',
          <NumberInput
            value={draft.maxWaitHours ?? globalOn.maxWaitHours}
            min={WAIT_HOURS.min}
            max={WAIT_HOURS.max}
            aria-label={t('providers:onLimit.maxWait.aria')}
            onChange={(v) => v !== undefined && change({ maxWaitHours: clampInt(v, WAIT_HOURS.min, WAIT_HOURS.max) })}
          />,
          t('providers:onLimit.maxWait.value', { hours: globalOn.maxWaitHours }),
        )}
        {inherited(
          'maxMoves',
          <NumberInput
            value={draft.maxMoves ?? globalOn.maxMoves}
            min={MOVES.min}
            max={MOVES.max}
            aria-label={t('providers:onLimit.maxMoves.aria')}
            onChange={(v) => v !== undefined && change({ maxMoves: clampInt(v, MOVES.min, MOVES.max) })}
          />,
          String(globalOn.maxMoves),
        )}
      </div>
      <ErrorBox error={save.error} title={t('projects:general.saveFailed')} />
    </>
  );

  const actions = (
    <div className="project-general-actions">
      {!narrow && (
        <button type="button" className="btn prov-quiet" disabled={!dirty || save.isPending} onClick={() => setEdit(null)}>
          {t('projects:general.discard')}
        </button>
      )}
      <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? t('projects:general.saving') : t('projects:general.save')}
      </button>
    </div>
  );

  if (narrow) {
    return (
      <>
        <button type="button" className="settings-cell project-limits-cell" onClick={() => setOpen(true)}>
          <span className="settings-cell-name project-limits-text">
            <span>{t('project.title')}</span>
            <span className="mono small muted">{differing ? t('project.summaryDiffering', { count: differing }) : t('project.summaryInherited')}</span>
          </span>
          <ChevronRight {...ICON_SM} className="settings-cell-chevron" />
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={t('project.title')} description={t('project.intro')} side="bottom" className="prov-sheet" footer={actions}>
          {body}
        </Sheet>
      </>
    );
  }

  return (
    <section className="card dp-card" aria-labelledby="project-providers-title">
      <div className="card-head">
        <h2 id="project-providers-title">{t('project.title')}</h2>
        <span className="dp-card-sub">{t('project.intro')}</span>
      </div>
      {body}
      <div className="dp-foot">{actions}</div>
    </section>
  );
}
