import type {
  DecisionMode,
  DecisionPointId,
  DecisionPointInfo,
  DecisionPointStats,
  DecisionProviderId,
  DecisionSettings,
  DecisionSettingsUpdate,
  DecisionTestResult,
  DecisionUnavailableReason,
} from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, KeyRound, Save, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { NumberInput, Slider } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON, ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, ModelCombobox, Segmented, Skeleton, Tag } from '../../components/ui';
import { useDirty } from '../../lib/dirty';
import { formatNumber, timeAgo } from '../../lib/format';
import { BulkConsentDialog } from './decisions/BulkConsentDialog';
import { BulkMode } from './decisions/BulkMode';
import { ConsentDialog } from './decisions/ConsentDialog';
import { DecisionHistory } from './decisions/DecisionHistory';
import { type BulkPlan, activeBlocked, needsConsent, planBulk } from './decisions/model';
import { METRICS_DAYS, PointMetrics } from './decisions/PointMetrics';
import { SupervisorTab } from './SupervisorTab';
import type { DecisionsSection } from './settingsTabs';

/** The server refuses a ceiling outside (0, 5] and a history outside 1..365 days. */
const MAX_COST = 5;
const MAX_HISTORY_DAYS = 365;
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.99;
/** Where Jev runs; the privacy notice names it so nobody has to guess where the state goes. */
const JEV_HOST = 'api.typesafe.ai';
/** "When it repeats" (D10): this many of the last `RECENT` Jev requests failing raises the warning. */
const RECENT = 10;
const REPEATS = 3;
const EFFORTS = ['low', 'medium', 'high'] as const;
type Effort = (typeof EFFORTS)[number];
const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);
export const MODES: DecisionMode[] = ['off', 'shadow', 'active'];

/** The ids hold dots, which i18next reads as nesting, so each point has a flat camelCase key. */
export const POINT_KEY: Record<DecisionPointId, string> = {
  'flow.refine-needed': 'flowRefineNeeded',
  'flow.bounce': 'flowBounce',
  'flow.scope-drift': 'flowScopeDrift',
  'flow.criteria-precheck': 'flowCriteriaPrecheck',
  'flow.criteria-merge': 'flowCriteriaMerge',
  'flow.restart': 'flowRestart',
  'board.triage': 'boardTriage',
  'team.assign': 'teamAssign',
  'memory.triage': 'memoryTriage',
  'journal.relevance': 'journalRelevance',
  'assistant.rerank': 'assistantRerank',
  'assistant.sources': 'assistantSources',
  'orchestration.retry': 'orchestrationRetry',
  'orchestration.model': 'orchestrationModel',
  'orchestration.fixer': 'orchestrationFixer',
  'run.continuation': 'runContinuation',
  'supervisor.intervene': 'supervisorIntervene',
  'health.semantic-loop': 'healthSemanticLoop',
  'health.test-weakening': 'healthTestWeakening',
  'changes.unexplained-hunk': 'changesUnexplainedHunk',
  'notification.urgency': 'notificationUrgency',
  'palette.intent': 'paletteIntent',
};

export type AreaId = 'flow' | 'board' | 'memory' | 'assistant' | 'orchestrations' | 'health' | 'review' | 'notifications' | 'palette';

/** `run.continuation` sits under Orchestrations although it also serves the flow (the plan's call). */
export const AREAS: ReadonlyArray<{ id: AreaId; points: readonly DecisionPointId[] }> = [
  { id: 'flow', points: ['flow.refine-needed', 'flow.bounce', 'flow.scope-drift', 'flow.criteria-precheck', 'flow.criteria-merge', 'flow.restart'] },
  { id: 'board', points: ['board.triage', 'team.assign'] },
  { id: 'memory', points: ['memory.triage', 'journal.relevance'] },
  { id: 'assistant', points: ['assistant.rerank', 'assistant.sources'] },
  { id: 'orchestrations', points: ['orchestration.retry', 'orchestration.model', 'orchestration.fixer', 'run.continuation'] },
  { id: 'health', points: ['supervisor.intervene', 'health.semantic-loop', 'health.test-weakening'] },
  { id: 'review', points: ['changes.unexplained-hunk'] },
  { id: 'notifications', points: ['notification.urgency'] },
  { id: 'palette', points: ['palette.intent'] },
];

/** The sections of the tab, in order: the ids are what `?tab=supervisor` and the chips scroll to. */
const SECTIONS: readonly DecisionsSection[] = ['engine', 'points', 'supervisor', 'history'];
export const sectionId = (section: DecisionsSection) => `decisions-${section}`;

interface PointDraft {
  mode: DecisionMode;
  threshold: number;
}

interface Draft {
  provider: DecisionProviderId;
  cli: DecisionSettings['cli'];
  historyDays: number;
  points: Partial<Record<DecisionPointId, PointDraft>>;
}

const draftOf = (saved: DecisionSettings): Draft => ({
  provider: saved.provider,
  cli: saved.cli,
  historyDays: saved.historyDays,
  points: Object.fromEntries(Object.entries(saved.points).map(([id, point]) => [id, { mode: point.mode, threshold: point.threshold }])),
});

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Settings → Decisions: the engine every decision point runs on, the points themselves, and the
 * supervisor, which is the same idea (a small model proposes, a person disposes) with its own file.
 */
export function DecisionsTab({ section }: { section?: DecisionsSection }) {
  const { t } = useTranslation('decisions');
  const settings = useQuery({ queryKey: keys.decisionSettings, queryFn: () => api.decisionSettings() });
  const points = useQuery({ queryKey: keys.decisionPoints, queryFn: () => api.decisionPoints() });

  // Reached from `?tab=supervisor`: wait for the sections to exist, then bring the asked one into view
  const ready = Boolean(settings.data && points.data);
  // "See in History" on a point's metrics: History filters by that point and comes into view
  const [historyFocus, setHistoryFocus] = useState<{ point: DecisionPointId; n: number } | null>(null);
  const showHistory = (point: DecisionPointId) => {
    setHistoryFocus((current) => ({ point, n: (current?.n ?? 0) + 1 }));
    document.getElementById(sectionId('history'))?.scrollIntoView({ block: 'start' });
  };
  useEffect(() => {
    if (!section || !ready) return;
    document.getElementById(sectionId(section))?.scrollIntoView({ block: 'start' });
  }, [section, ready]);

  return (
    <div className="dp-page">
      <p className="small muted">{t('intro')}</p>
      <nav className="dp-nav" aria-label={t('nav')}>
        {SECTIONS.map((id) => (
          <a
            key={id}
            className="chip"
            href={`#${sectionId(id)}`}
            onClick={(event) => {
              // A hash link would change the route the tab lives on
              event.preventDefault();
              document.getElementById(sectionId(id))?.scrollIntoView({ block: 'start' });
            }}
          >
            {t(`sections.${id}`)}
          </a>
        ))}
      </nav>
      <ErrorBox error={settings.error ?? points.error} />
      {!settings.data || !points.data ? (
        <Skeleton rows={6} />
      ) : (
        <DecisionsForm saved={settings.data} catalogue={points.data} onHistory={showHistory} />
      )}
      <div id={sectionId('supervisor')}>
        <SupervisorTab />
      </div>
      <DecisionHistory id={sectionId('history')} catalogue={points.data ?? []} days={settings.data?.historyDays ?? null} focusPoint={historyFocus} />
    </div>
  );
}

function DecisionsForm({ saved, catalogue, onHistory }: { saved: DecisionSettings; catalogue: DecisionPointInfo[]; onHistory: (point: DecisionPointId) => void }) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(() => draftOf(saved));
  const base = useMemo(() => draftOf(saved), [saved]);
  const dirty = !sameDraft(draft, base);
  useDirty('decisions', dirty);

  // A consent or a key saved elsewhere on the page replaces `saved`, but must not undo what is being edited
  const previous = useRef(base);
  useEffect(() => {
    const before = previous.current;
    previous.current = base;
    if (before !== base) setDraft((current) => (sameDraft(current, before) ? base : current));
  }, [base]);

  // A point leaving `off` without consent for what it sends now waits here for the person to see it
  const [asking, setAsking] = useState<{ id: DecisionPointId; mode: Exclude<DecisionMode, 'off'> } | null>(null);
  const setMode = (id: DecisionPointId, mode: DecisionMode) =>
    setDraft((current) => ({ ...current, points: { ...current.points, [id]: { ...pointOf(current, catalogue, id), mode } } }));
  const onMode = (id: DecisionPointId, mode: DecisionMode) => {
    const info = catalogue.find((point) => point.id === id);
    if (mode !== 'off' && info && needsConsent(info, saved.points[id]?.consent ?? null, draft.provider)) setAsking({ id, mode });
    else setMode(id, mode);
  };

  // Setting many points at once: what it did is said under the control until the next change
  const [bulkAsking, setBulkAsking] = useState<{ plan: BulkPlan; mode: DecisionMode } | null>(null);
  const [bulkNote, setBulkNote] = useState<{ mode: DecisionMode; set: number; unchanged: number; kept: number; keptMode: DecisionMode } | null>(null);
  const applyPlan = (plan: BulkPlan, mode: DecisionMode) => {
    setDraft((current) => {
      const points = { ...current.points };
      for (const change of plan.changes) points[change.id] = { ...pointOf(current, catalogue, change.id), mode: change.mode };
      return { ...current, points };
    });
    // A point kept at shadow counts once, as kept: it is neither "set" to the asked mode nor merely "already there"
    const kept = new Set(plan.capped);
    setBulkNote({
      mode,
      set: plan.changes.filter((change) => change.mode === mode).length,
      unchanged: plan.unchanged.filter((id) => !kept.has(id)).length,
      kept: kept.size,
      keptMode: 'shadow',
    });
  };
  const onBulk = (ids: readonly DecisionPointId[], mode: DecisionMode) => {
    const plan = planBulk(catalogue, ids, mode, (id) => draft.points[id]?.mode ?? 'off', (id) => saved.points[id]?.consent ?? null, draft.provider);
    if (plan.needConsent.length > 0) setBulkAsking({ plan, mode });
    else applyPlan(plan, mode);
  };
  const askedInfo = asking ? catalogue.find((point) => point.id === asking.id) : undefined;

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const costValid = Number.isFinite(draft.cli.maxCostUsd) && draft.cli.maxCostUsd > 0 && draft.cli.maxCostUsd <= MAX_COST;
  const daysValid = Number.isInteger(draft.historyDays) && draft.historyDays >= 1 && draft.historyDays <= MAX_HISTORY_DAYS;
  const valid = draft.cli.model.trim() !== '' && costValid && daysValid;

  const save = useMutation({
    mutationFn: () => {
      // Consent is not part of the document the server accepts as a change, but it is part of its shape
      const ids = new Set<DecisionPointId>([...(Object.keys(saved.points) as DecisionPointId[]), ...(Object.keys(draft.points) as DecisionPointId[])]);
      const body: DecisionSettingsUpdate = {
        provider: draft.provider,
        cli: { ...draft.cli, model: draft.cli.model.trim() },
        historyDays: draft.historyDays,
        points: Object.fromEntries(
          [...ids].map((id) => {
            const point = draft.points[id] ?? { mode: 'off' as const, threshold: catalogue.find((p) => p.id === id)?.defaultThreshold ?? THRESHOLD_MIN };
            return [id, { ...point, consent: saved.points[id]?.consent ?? null }];
          }),
        ),
      };
      return api.putDecisionSettings(body);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(keys.decisionSettings, next);
      void queryClient.invalidateQueries({ queryKey: keys.decisionPoints });
      toast.success(t('engine.saved'));
    },
  });

  return (
    <>
      <EngineSection saved={saved} draft={draft} patch={patch} costValid={costValid} daysValid={daysValid} />
      <PointsSection
        catalogue={catalogue}
        settings={saved}
        draft={draft}
        onMode={onMode}
        onBulk={onBulk}
        bulkNote={bulkNote}
        onHistory={onHistory}
        onThreshold={(id, threshold) =>
          setDraft((current) => ({ ...current, points: { ...current.points, [id]: { ...pointOf(current, catalogue, id), threshold } } }))
        }
      />
      {asking && askedInfo && (
        <ConsentDialog
          info={askedInfo}
          name={t(`points.names.${POINT_KEY[askedInfo.id] ?? askedInfo.id}`, { defaultValue: askedInfo.id })}
          provider={draft.provider}
          mode={asking.mode}
          consent={saved.points[asking.id]?.consent ?? null}
          onClose={() => setAsking(null)}
          onGranted={() => {
            setMode(asking.id, asking.mode);
            setAsking(null);
          }}
        />
      )}
      {bulkAsking && (
        <BulkConsentDialog
          provider={draft.provider}
          items={bulkAsking.plan.needConsent.flatMap(({ id, mode }) => {
            const info = catalogue.find((point) => point.id === id);
            return info
              ? [{ info, mode, name: t(`points.names.${POINT_KEY[id] ?? id}`, { defaultValue: id }), consent: saved.points[id]?.consent ?? null }]
              : [];
          })}
          onClose={() => setBulkAsking(null)}
          onGranted={() => {
            applyPlan(bulkAsking.plan, bulkAsking.mode);
            setBulkAsking(null);
          }}
        />
      )}
      {(dirty || save.isPending) && (
        <div className="dp-foot card" role="group" aria-label={t('engine.save')}>
          <ErrorBox error={save.error} />
          <button type="button" className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            <Save {...ICON_SM} /> {save.isPending ? t('engine.saving') : t('engine.save')}
          </button>
          <button type="button" className="btn" disabled={save.isPending} onClick={() => setDraft(base)}>
            {t('engine.discard')}
          </button>
        </div>
      )}
    </>
  );
}

function pointOf(draft: Draft, catalogue: DecisionPointInfo[], id: DecisionPointId): PointDraft {
  return draft.points[id] ?? { mode: 'off', threshold: catalogue.find((p) => p.id === id)?.defaultThreshold ?? THRESHOLD_MIN };
}

function EngineSection({
  saved,
  draft,
  patch,
  costValid,
  daysValid,
}: {
  saved: DecisionSettings;
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  costValid: boolean;
  daysValid: boolean;
}) {
  const { t } = useTranslation('decisions');
  // A value the server accepts but the picker does not list (xhigh, max) stays visible rather than vanishing
  const efforts: string[] = isEffort(draft.cli.effort) ? [...EFFORTS] : [...EFFORTS, draft.cli.effort];

  return (
    <section id={sectionId('engine')} className="card dp-card" aria-labelledby="decisions-engine-title">
      <div className="card-head">
        <h2 id="decisions-engine-title">{t('engine.title')}</h2>
        <span className="dp-card-sub">{t('engine.sub')}</span>
      </div>
      <JevUnavailable provider={draft.provider} />
      <div className="dp-setting">
        <div className="dp-setting-label">
          <span>{t('engine.provider')}</span>
          <span>{t('engine.providerHint')}</span>
        </div>
        <div className="dp-setting-body">
          <Segmented
            label={t('engine.provider')}
            value={draft.provider}
            onChange={(provider) => patch({ provider })}
            options={[
              { value: 'cli', label: t('engine.cli') },
              { value: 'jev', label: <JevLabel /> },
            ]}
          />
          <span className="form-hint">{t('engine.providerProjects')}</span>
        </div>
      </div>
      <div className="dp-setting">
        <div className="dp-setting-label">
          <span>{t('engine.cli')}</span>
          <span>{t('engine.cliHint')}</span>
        </div>
        <div className="dp-setting-body">
          <div className="dp-inline">
            <div className="dp-model">
              <ModelCombobox aria-label={t('engine.cliModel')} value={draft.cli.model} onChange={(model) => patch({ cli: { ...draft.cli, model } })} />
            </div>
            {/* CW-25's effort control is not merged yet: a Segmented it can reuse */}
            <Segmented
              label={t('engine.effort')}
              value={draft.cli.effort}
              onChange={(effort) => patch({ cli: { ...draft.cli, effort } })}
              options={efforts.map((value) => ({ value, label: isEffort(value) ? t(`engine.effortOptions.${value}`) : value }))}
            />
            <div className="dp-cost">
              <NumberInput
                aria-label={t('engine.maxCost')}
                decimal
                min={0.01}
                max={MAX_COST}
                step={0.01}
                value={draft.cli.maxCostUsd}
                onChange={(maxCostUsd) => patch({ cli: { ...draft.cli, maxCostUsd: maxCostUsd ?? 0 } })}
              />
            </div>
          </div>
          <span className="form-hint">{t('engine.maxCost')}</span>
          {!costValid && (
            <p className="alert alert-warn small" role="status">
              {t('engine.maxCostInvalid', { max: MAX_COST })}
            </p>
          )}
        </div>
      </div>
      <JevKey saved={saved} />
      <div className="dp-setting">
        <div className="dp-setting-label">
          <span>{t('engine.jevModel')}</span>
          <span>{t('engine.jevModelHint')}</span>
        </div>
        <div className="dp-setting-body">
          <div className="dp-inline">
            <span className="dp-mono">{saved.jev.model}</span>
            <span className="badge">{t('engine.pinned')}</span>
          </div>
        </div>
      </div>
      <div className="dp-setting">
        <div className="dp-setting-label">
          <span>{t('engine.privacy')}</span>
          <span>{t('engine.privacyHint')}</span>
        </div>
        <div className="dp-setting-body">
          <div className="alert alert-info">
            <ShieldCheck className="alert-icon" {...ICON} />
            <div className="alert-body dp-note-card">
              <strong>{t('engine.privacyTitle')}</strong>
              <span>{t('engine.privacyBody', { host: JEV_HOST })}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="dp-setting">
        <div className="dp-setting-label">
          <span>{t('engine.historyDays')}</span>
          <span>{t('engine.historyDaysHint')}</span>
        </div>
        <div className="dp-setting-body">
          <div className="dp-cost">
            <NumberInput
              aria-label={t('engine.historyDays')}
              min={1}
              max={MAX_HISTORY_DAYS}
              value={draft.historyDays}
              onChange={(historyDays) => patch({ historyDays: historyDays ?? 0 })}
            />
          </div>
          {!daysValid && (
            <p className="alert alert-warn small" role="status">
              {t('engine.historyDaysHint')}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Jev ships as a beta: an outside service still being measured in shadow, so it says so wherever it is chosen. */
function BetaTag() {
  const { t } = useTranslation('decisions');
  return <Tag tone="info">{t('engine.beta')}</Tag>;
}

function JevLabel() {
  const { t } = useTranslation('decisions');
  return (
    <span className="dp-beta-title">
      {t('engine.jev')} <BetaTag />
    </span>
  );
}

/** The warning of D10: shown when the last Jev requests keep failing, and only while Jev is the provider. */
function JevUnavailable({ provider }: { provider: DecisionProviderId }) {
  const { t } = useTranslation('decisions');
  const recent = useQuery({
    queryKey: keys.decisionsRecent({ provider: 'jev', limit: RECENT }),
    queryFn: () => api.decisions({ provider: 'jev', limit: RECENT }),
    refetchInterval: 30_000,
  });
  if (provider !== 'jev' || !recent.data) return null;
  const failed = recent.data.items.filter((row) => row.status === 'unavailable');
  if (failed.length < REPEATS) return null;
  const counts = new Map<DecisionUnavailableReason, number>();
  for (const row of failed) if (row.unavailable) counts.set(row.unavailable, (counts.get(row.unavailable) ?? 0) + 1);
  const reasons = [...counts].map(([reason, n]) => `${formatNumber(n)} ${t(`engine.reason.${reason}`)}`).join(', ');
  const last = failed[0];
  return (
    <div className="dp-block">
      <div className="alert alert-warn" role="status">
        <TriangleAlert className="alert-icon" {...ICON} />
        <div className="alert-body dp-note-card">
          <strong>{t('engine.unavailableTitle')}</strong>
          <span>
            {t('engine.unavailableBody', {
              failed: formatNumber(failed.length),
              total: formatNumber(recent.data.items.length),
              reasons,
              when: last ? timeAgo(last.at) : '',
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

function JevKey({ saved }: { saved: DecisionSettings }) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [result, setResult] = useState<DecisionTestResult | null>(null);
  const [testedAt, setTestedAt] = useState<number | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.decisionSettings });
  const putKey = useMutation({
    mutationFn: () => api.putDecisionKey(key.trim()),
    onSuccess: () => {
      setKey('');
      setEditing(false);
      setResult(null);
      refresh();
      toast.success(t('engine.keySaved'));
    },
  });
  const removeKey = useMutation({
    mutationFn: () => api.deleteDecisionKey(),
    onSuccess: () => {
      setResult(null);
      refresh();
      toast.success(t('engine.keyRemoved'));
    },
  });
  const test = useMutation({
    mutationFn: () => api.testDecisionProvider('jev'),
    onSuccess: (next) => {
      setResult(next);
      setTestedAt(Date.now());
    },
  });

  const remove = async () => {
    const ok = await confirm({
      title: t('engine.removeKeyTitle'),
      body: t('engine.removeKeyBody'),
      confirmLabel: t('engine.removeKey'),
      danger: true,
    });
    if (ok) removeKey.mutate();
  };
  const showInput = editing || !saved.jev.keySet;

  return (
    <div className="dp-setting">
      <div className="dp-setting-label">
        <span className="dp-beta-title">
          {t('engine.jevKey')} <BetaTag />
        </span>
        <span>{t('engine.jevKeyHint')}</span>
      </div>
      <div className="dp-setting-body">
        {showInput ? (
          <form
            className="dp-inline"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim() !== '') putKey.mutate();
            }}
          >
            <div className="field dp-key">
              <input
                type="password"
                className="mono"
                autoComplete="off"
                aria-label={t('engine.jevKeyInput')}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={key.trim() === '' || putKey.isPending}>
              <KeyRound {...ICON_SM} /> {putKey.isPending ? t('engine.savingKey') : t('engine.saveKey')}
            </button>
            {saved.jev.keySet && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setEditing(false);
                  setKey('');
                }}
              >
                {t('engine.cancelKey')}
              </button>
            )}
          </form>
        ) : (
          <div className="dp-inline">
            <span className="dp-mono" aria-label={t('engine.jevKeyInput')}>
              {'••••••••••••'}
              {saved.jev.keyHint ?? ''}
            </span>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              {t('engine.changeKey')}
            </button>
            <button type="button" className="btn btn-ghost" disabled={removeKey.isPending} onClick={() => void remove()}>
              {t('engine.removeKey')}
            </button>
          </div>
        )}
        <ErrorBox error={putKey.error ?? removeKey.error ?? test.error} />
        {saved.jev.keySet && (
          <div className="dp-key-state">
            <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
              <Cpu {...ICON_SM} /> {test.isPending ? t('engine.testing') : t('engine.test')}
            </button>
            {result && (
              <>
                <span className={`badge ${result.ok ? 'badge-ok' : 'badge-bad'}`}>
                  <span className={`dot ${result.ok ? 'dot-ok' : 'dot-bad'}`} />
                  {result.ok ? t('engine.connected') : t('engine.failed')}
                </span>
                <span className="mono">
                  {result.ok ? `${formatNumber(result.latencyMs / 1000, { maximumFractionDigits: 1 })} s` : result.reason ? t(`engine.reason.${result.reason}`) : ''}
                  {testedAt !== null && ` · ${timeAgo(testedAt)}`}
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PointsSection({
  catalogue,
  settings,
  draft,
  onMode,
  onBulk,
  bulkNote,
  onThreshold,
  onHistory,
}: {
  catalogue: DecisionPointInfo[];
  settings: DecisionSettings;
  draft: Draft;
  onMode: (id: DecisionPointId, mode: DecisionMode) => void;
  onBulk: (ids: readonly DecisionPointId[], mode: DecisionMode) => void;
  bulkNote: { mode: DecisionMode; set: number; unchanged: number; kept: number; keptMode: DecisionMode } | null;
  onThreshold: (id: DecisionPointId, threshold: number) => void;
  onHistory: (point: DecisionPointId) => void;
}) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const toast = useToast();
  const stats = useQuery({ queryKey: keys.decisionStats(METRICS_DAYS), queryFn: () => api.decisionStats(METRICS_DAYS) });
  const statsOf = new Map<DecisionPointId, DecisionPointStats>((stats.data?.points ?? []).map((row) => [row.point, row]));
  // Consent is withdrawn from the row: it is a setting of its own, saved at once, apart from the form
  const withdraw = useMutation({
    mutationFn: (info: DecisionPointInfo) => api.putDecisionConsent(info.id, { granted: false, stateVersion: info.stateVersion, providers: [] }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.decisionSettings, next);
      toast.success(t('consent.withdrawn'));
    },
  });
  const byId = new Map(catalogue.map((info) => [info.id, info]));
  // A point the catalogue has and no area lists (a newer server) still shows, last, rather than vanishing
  const listed = new Set(AREAS.flatMap((area) => area.points));
  const extra = catalogue.filter((info) => !listed.has(info.id)).map((info) => info.id);
  const groups: Array<{ id: AreaId | 'other'; points: readonly DecisionPointId[] }> = [
    ...AREAS.map((area) => ({ id: area.id as AreaId | 'other', points: area.points.filter((id) => byId.has(id)) })),
    { id: 'other' as const, points: extra },
  ].filter((group) => group.points.length > 0);

  return (
    <section id={sectionId('points')} className="card dp-card" aria-labelledby="decisions-points-title">
      <div className="card-head">
        <h2 id="decisions-points-title">{t('points.title')}</h2>
        <span className="dp-card-sub">{t('points.count', { points: catalogue.length, groups: groups.length })}</span>
      </div>
      <div className="dp-intro">
        <p>{t('points.intro')}</p>
      </div>
      {groups.length > 0 && (
        <div className="dp-bulk">
          <span className="dp-bulk-label">{t('bulk.all', { count: catalogue.length })}</span>
          <BulkMode scope={t('bulk.allScope')} onApply={(mode) => onBulk(catalogue.map((info) => info.id), mode)} />
          {bulkNote && (
            <p className="dp-bulk-note small muted" role="status">
              {t('bulk.result', { count: bulkNote.set, mode: t(`points.modes.${bulkNote.mode}`) })}
              {bulkNote.unchanged > 0 && ` ${t('bulk.unchanged', { count: bulkNote.unchanged })}`}
              {bulkNote.kept > 0 && ` ${t('bulk.kept', { count: bulkNote.kept, mode: t(`points.modes.${bulkNote.keptMode}`) })}`}
              {` ${t('bulk.saveHint')}`}
            </p>
          )}
        </div>
      )}
      <ErrorBox error={withdraw.error} />
      {groups.length === 0 && <p className="small muted dp-empty">{t('points.none')}</p>}
      {groups.map((group) => (
        <div key={group.id} className="dp-group" role="group" aria-label={t(`points.areas.${group.id}`)}>
          <div className="dp-group-head">
            <span className="section-label">{t(`points.areas.${group.id}`)}</span>
            <span className="dp-group-count">{formatNumber(group.points.length)}</span>
            <BulkMode scope={t(`points.areas.${group.id}`)} onApply={(mode) => onBulk(group.points, mode)} />
          </div>
          {group.points.map((id) => {
            const info = byId.get(id);
            return (
              info && (
                <PointRow
                  key={id}
                  info={info}
                  settings={settings}
                  draft={draft}
                  provider={draft.provider}
                  onMode={onMode}
                  onThreshold={onThreshold}
                  stats={statsOf.get(id)}
                  onHistory={() => onHistory(id)}
                  onWithdraw={() => withdraw.mutate(info)}
                />
              )
            );
          })}
        </div>
      ))}
    </section>
  );
}

export function PointRow({
  info,
  settings,
  draft,
  provider,
  onMode,
  onThreshold,
  stats,
  onHistory,
  onWithdraw,
}: {
  info: DecisionPointInfo;
  settings: DecisionSettings;
  draft: Draft;
  provider: DecisionProviderId;
  onMode: (id: DecisionPointId, mode: DecisionMode) => void;
  onThreshold: (id: DecisionPointId, threshold: number) => void;
  stats?: DecisionPointStats | undefined;
  onHistory?: () => void;
  onWithdraw?: () => void;
}) {
  const { t } = useTranslation('decisions');
  const name = t(`points.names.${POINT_KEY[info.id] ?? info.id}`, { defaultValue: info.id });
  const point = draft.points[info.id] ?? { mode: 'off' as const, threshold: info.defaultThreshold };
  const consent = settings.points[info.id]?.consent ?? null;
  const consentState = !consent ? 'none' : consent.stateVersion === info.stateVersion ? 'given' : 'stale';
  // An act point changes what happens, so on the CLI (no calibrated confidence) it cannot be active
  const blocked = activeBlocked(info, provider);
  const off = point.mode === 'off';

  return (
    <div className="dp-row" data-point={info.id}>
      <div className="dp-name">
        <span>{name}</span>
        <span className="dp-id">{info.id}</span>
      </div>
      <span className="dp-kind">
        {t(`points.kind.${info.kind}`)}
        <small>{t(`points.scope.${info.scope}`)}</small>
      </span>
      <Segmented
        label={t('points.mode', { point: info.id })}
        value={point.mode}
        onChange={(mode) => onMode(info.id, mode)}
        options={MODES.map((mode) => ({
          value: mode,
          label: t(`points.modes.${mode}`),
          ...(mode === 'active' && blocked ? { disabled: true, title: t('points.activeNeedsJev') } : {}),
        }))}
      />
      {info.kind === 'act' ? (
        <div className="dp-thr">
          <Slider
            aria-label={t('points.threshold', { point: info.id })}
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={0.01}
            value={point.threshold}
            disabled={off}
            onChange={(threshold) => onThreshold(info.id, Math.round(threshold * 100) / 100)}
          />
          <output>{formatNumber(point.threshold, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</output>
        </div>
      ) : (
        <span className="dp-none">{t('points.noThreshold')}</span>
      )}
      <span className={`dp-consent ${consentState === 'given' ? '' : 'is-none'}`} title={consentState === 'stale' ? t('points.consent.staleHint') : undefined}>
        {consentState === 'given' && <span className="dot dot-ok" aria-hidden />}
        {consentState === 'given' ? t('points.consent.given') : consentState === 'stale' ? t('points.consent.stale') : t('points.consent.none')}
        {consent && <span className="mono">v{consent.stateVersion}</span>}
        {consent && onWithdraw && (
          <button type="button" className="btn btn-ghost btn-small" aria-label={t('consent.withdrawPoint', { point: info.id })} onClick={onWithdraw}>
            {t('consent.withdrawAction')}
          </button>
        )}
      </span>
      {/* A point that is off has no week to show */}
      {!off && <PointMetrics stats={stats} {...(onHistory ? { onHistory } : {})} />}
    </div>
  );
}
