import type { DecisionMode, DecisionPointId, DecisionPointInfo, DecisionProviderId, Project, ProjectDecisionSettings } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useProjectSettings } from '../../api';
import { Collapsible, Sheet, Slider } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Segmented, Skeleton } from '@agentry/ui/components/ui';
import { useDirty } from '../../lib/dirty';
import { formatNumber } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { AREAS, MODES, POINT_KEY, THRESHOLD_MAX, THRESHOLD_MIN, type AreaId } from '../config/DecisionsTab';

type Provider = 'inherit' | DecisionProviderId;
type Override = { mode?: DecisionMode; threshold?: number };
type Overrides = Partial<Record<DecisionPointId, Override>>;

const sameOverrides = (a: Overrides, b: Overrides) => JSON.stringify(a) === JSON.stringify(b);
const fixed2 = (value: number) => formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What goes in `ProjectSettings.decisions`: nothing at all when nothing differs from the global. */
export function decisionsOf(provider: Provider, points: Overrides): ProjectDecisionSettings | undefined {
  const kept: Overrides = {};
  for (const [id, o] of Object.entries(points) as Array<[DecisionPointId, Override | undefined]>) {
    if (o && (o.mode !== undefined || o.threshold !== undefined)) kept[id] = o;
  }
  const out: ProjectDecisionSettings = {};
  if (provider !== 'inherit') out.provider = provider;
  if (Object.keys(kept).length) out.points = kept;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The project's Decisions override: a provider and, for each point a project may set, a mode and a
 * threshold that show the global value until changed. Consent stays global (it is about what leaves
 * the machine), so nothing here can grant it.
 */
export function ProjectDecisions({ project }: { project: Project }) {
  const { t } = useTranslation(['projects', 'decisions']);
  const narrow = useMediaQuery(NARROW);
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useProjectSettings(project.id);
  const global = useQuery({ queryKey: keys.decisionSettings, queryFn: () => api.decisionSettings() });
  const catalogue = useQuery({ queryKey: keys.decisionPoints, queryFn: () => api.decisionPoints() });

  const saved = useMemo(
    () => ({ provider: (settings.data?.decisions?.provider ?? 'inherit') as Provider, points: (settings.data?.decisions?.points ?? {}) as Overrides }),
    [settings.data],
  );
  const [edit, setEdit] = useState<{ base: typeof saved; provider: Provider; points: Overrides } | null>(null);
  // What was saved elsewhere shows here unless the person edited: an edit made on an older `saved` is dropped
  const draft = edit && edit.base === saved ? edit : { base: saved, provider: saved.provider, points: saved.points };
  const change = (next: { provider?: Provider; points?: Overrides }) => setEdit({ ...draft, ...next });
  const dirty = draft.provider !== saved.provider || !sameOverrides(draft.points, saved.points);
  useDirty('project-decisions', dirty);
  const [open, setOpen] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      // The document is replaced whole: read it again right before writing
      const fresh = await api.projectSettings(project.id);
      const { decisions: _previous, ...rest } = fresh;
      const decisions = decisionsOf(draft.provider, draft.points);
      return api.putProjectSettings(project.id, decisions ? { ...rest, decisions } : rest);
    },
    onSuccess: () => {
      setEdit(null);
      toast.success(t('decisions.saved'));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.projectSettings(project.id) }),
  });

  if (settings.isLoading || global.isLoading || catalogue.isLoading) return <Skeleton rows={4} height={18} />;
  if (!global.data || !catalogue.data) return <ErrorBox error={global.error ?? catalogue.error} />;

  const keySet = global.data.jev.keySet;
  const provider: DecisionProviderId = draft.provider === 'inherit' ? global.data.provider : draft.provider;
  const byId = new Map(catalogue.data.filter((info) => info.scope === 'project').map((info) => [info.id, info]));
  const differing = Object.keys(draft.points).filter((id) => byId.has(id as DecisionPointId)).length;

  const setPoint = (id: DecisionPointId, patch: Override) => change({ points: { ...draft.points, [id]: { ...draft.points[id], ...patch } } });
  const reset = (id: DecisionPointId) => {
    const { [id]: _gone, ...rest } = draft.points;
    change({ points: rest });
  };

  const groups = AREAS.map((area) => ({ id: area.id, ids: area.points.filter((id) => byId.has(id)) })).filter((g) => g.ids.length > 0);

  const groupHead = (id: AreaId, ids: readonly DecisionPointId[]) => (
    <>
      <span className="section-label">{t(`decisions:points.areas.${id}`)}</span>
      <span className="dp-group-count">
        {t('decisions.groupCount', { count: ids.length, n: formatNumber(ids.length), differing: formatNumber(ids.filter((pid) => draft.points[pid]).length) })}
      </span>
    </>
  );
  const row = (id: DecisionPointId) => {
    const info = byId.get(id);
    return (
      info && (
        <OverrideRow key={id} info={info} override={draft.points[id]} provider={provider} onChange={(patch) => setPoint(id, patch)} onReset={() => reset(id)} />
      )
    );
  };

  const actions = (
    <div className="project-general-actions">
      {!narrow && (
        <button type="button" className="btn btn-quiet" disabled={!dirty || save.isPending} onClick={() => setEdit(null)}>
          {t('general.discard')}
        </button>
      )}
      <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? t('general.saving') : t('general.save')}
      </button>
    </div>
  );

  const body = (
    <>
      <div className="dp-block">
        <span className="section-label">{t('decisions.provider')}</span>
        <Segmented
          label={t('decisions.providerLabel')}
          value={draft.provider}
          onChange={(next) => change({ provider: next })}
          options={[
            { value: 'inherit', label: narrow ? t('decisions.inheritShort') : t('decisions.inherit', { provider: t(`decisions:engine.${global.data.provider}`) }) },
            { value: 'cli', label: t('decisions:engine.cli') },
            { value: 'jev', label: t('decisions:engine.jev'), ...(keySet ? {} : { disabled: true, title: t('decisions.jevNeedsKey') }) },
          ]}
        />
        <span className="form-hint">{keySet ? t('decisions.jevAvailable') : t('decisions.jevNeedsKey')}</span>
      </div>
      {groups.map((group, index) =>
        narrow ? (
          <Collapsible key={group.id} className="dp-fold" defaultOpen={index === 0} title={groupHead(group.id, group.ids)}>
            {group.ids.map(row)}
          </Collapsible>
        ) : (
          <div key={group.id} className="dp-group" role="group" aria-label={t(`decisions:points.areas.${group.id}`)}>
            <div className="dp-group-head">{groupHead(group.id, group.ids)}</div>
            {group.ids.map(row)}
          </div>
        ),
      )}
      <ErrorBox error={save.error} title={t('general.saveFailed')} />
    </>
  );

  if (narrow) {
    return (
      <>
        <button type="button" className="settings-cell project-limits-cell" onClick={() => setOpen(true)}>
          <span className="settings-cell-name project-limits-text">
            <span>{t('decisions.title')}</span>
            <span className="mono small muted">{differing ? t('decisions.summaryDiffering', { count: differing, n: formatNumber(differing) }) : t('decisions.summaryInherited')}</span>
          </span>
          <ChevronRight {...ICON_SM} className="settings-cell-chevron" />
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={t('decisions.title')} description={t('decisions.intro')} side="bottom" footer={actions}>
          {body}
        </Sheet>
      </>
    );
  }

  return (
    <section className="card dp-card" aria-labelledby="project-decisions-title">
      <div className="card-head">
        <h2 id="project-decisions-title">{t('decisions.title')}</h2>
        <span className="dp-card-sub">{t('decisions.intro')}</span>
      </div>
      {body}
      <div className="dp-foot">{actions}</div>
    </section>
  );
}

function OverrideRow({
  info,
  override,
  provider,
  onChange,
  onReset,
}: {
  info: DecisionPointInfo;
  override: Override | undefined;
  provider: DecisionProviderId;
  onChange: (patch: Override) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation(['projects', 'decisions']);
  const name = t(`decisions:points.names.${POINT_KEY[info.id] ?? info.id}`, { defaultValue: info.id });
  const modeSet = override?.mode !== undefined;
  const thresholdSet = override?.threshold !== undefined;
  const mode = override?.mode ?? info.effective.mode;
  const threshold = override?.threshold ?? info.effective.threshold;
  // An act point on the CLI has no calibrated confidence to compare with its threshold
  const activeBlocked = info.kind === 'act' && provider === 'cli';

  return (
    <div className="dp-row" data-point={info.id}>
      <div className="dp-name">
        <span>{name}</span>
        <span className="dp-id">{info.id}</span>
      </div>
      <span className="dp-kind">{t(`decisions:points.kind.${info.kind}`)}</span>
      <Segmented
        label={t('decisions:points.mode', { point: info.id })}
        value={mode}
        onChange={(next) => onChange({ mode: next })}
        className={modeSet ? undefined : 'is-inherited'}
        options={MODES.map((m) => ({
          value: m,
          label: t(`decisions:points.modes.${m}`),
          ...(m === 'active' && activeBlocked ? { disabled: true, title: t('decisions:points.activeNeedsJev') } : {}),
        }))}
      />
      {info.kind === 'act' ? (
        <div className={`dp-thr ${thresholdSet ? '' : 'is-inherited'}`}>
          <Slider
            aria-label={t('decisions:points.threshold', { point: info.id })}
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={0.01}
            value={threshold}
            onChange={(next) => onChange({ threshold: Math.round(next * 100) / 100 })}
          />
          <output>{fixed2(threshold)}</output>
        </div>
      ) : (
        <span className="dp-none">{t('decisions:points.noThreshold')}</span>
      )}
      <span className="dp-consent is-none">
        {modeSet || thresholdSet ? (
          <>
            <span>{t('decisions.global', { mode: t(`decisions:points.modes.${info.effective.mode}`).toLocaleLowerCase() })}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>
              {t('decisions.useGlobal')}
            </button>
          </>
        ) : (
          t('decisions.inherited')
        )}
      </span>
    </div>
  );
}
