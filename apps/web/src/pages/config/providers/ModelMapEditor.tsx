import type { ModelMapSuggestion, ModelOption, ProviderId, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Shuffle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { Select, Sheet } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, Segmented, Tag } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { counterpart, isStale, offered, rotationOf, waitingPairs, withCounterpart } from './rotation';

/** The value of the "No counterpart" option: a `Select` takes strings and `null` is not one. */
const NONE = '';

type Pair = { from: { provider: ProviderId; model: string }; target: ProviderId };

/**
 * The model mapping: for each model of a provider, the model of each other provider that stands in
 * for it when work moves. It starts empty and nothing enters it without a person: a suggestion of the
 * `provider.model-map` point is shown as "suggested" and does not count until it is accepted. A
 * choice is saved at once, one entry at a time, over the document as it is now.
 */
export function ModelMapEditor({
  statuses,
  settings,
  onSave,
}: {
  statuses: ProviderStatus[];
  settings: ProvidersSettings;
  /** Writes the whole document; the page owns the mutation */
  onSave: (next: ProvidersSettings) => void;
}) {
  const { t } = useTranslation('providers');
  const narrow = useMediaQuery(NARROW);
  const toast = useToast();
  const queryClient = useQueryClient();
  const map = rotationOf(settings).modelMap;

  // Only a provider that is on can stand in, or be stood in for
  const enabled = statuses.filter((s) => settings.providers[s.id]?.enabled !== false);
  const catalogs = useQueries({
    queries: enabled.map((s) => ({ queryKey: keys.providerModels(s.id), queryFn: () => api.providerModels(s.id) })),
  });
  const catalogOf = new Map<ProviderId, ModelOption[] | undefined>(enabled.map((s, i) => [s.id, catalogs[i]?.data]));
  const withModels = enabled.filter((s) => offered(catalogOf.get(s.id)).length > 0);

  const suggestions = useQuery({ queryKey: keys.modelMapSuggestions, queryFn: () => api.modelMapSuggestions() });
  const waits = useQuery({ queryKey: keys.providerMoves('waiting'), queryFn: () => api.providerMoves({ state: 'waiting' }) });
  const waiting = waitingPairs(waits.data ?? []);

  const [fromId, setFromId] = useState<ProviderId | null>(null);
  const [pair, setPair] = useState<Pair | null>(null);
  const source = withModels.find((s) => s.id === fromId) ?? withModels[0];

  const answer = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => api.answerModelMapSuggestion(id, accept),
    onSuccess: (_done, { accept }) => toast.success(t(accept ? 'map.accepted' : 'map.dismissed')),
    onError: (err) => toast.error(t('map.answerFailed'), err),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.modelMapSuggestions });
      void queryClient.invalidateQueries({ queryKey: keys.providerSettings });
    },
  });

  const label = (id: ProviderId) => statuses.find((s) => s.id === id)?.label ?? id;
  const modelName = (id: ProviderId, model: string) => catalogOf.get(id)?.find((m) => m.value === model)?.label ?? model;
  const set = (from: Pair['from'], target: ProviderId, model: string | null) => onSave(withCounterpart(settings, from, { provider: target, model }, new Date().toISOString()));
  const suggestionFor = (from: Pair['from'], target: ProviderId): ModelMapSuggestion | undefined =>
    (suggestions.data ?? []).find((s) => s.from.provider === from.provider && s.from.model === from.model && s.to.provider === target);

  const intro = <p className="rot-intro-text">{t('map.intro')}</p>;
  const head = (
    <span className="mono prov-summary">{map.length === 0 ? t('map.empty') : t('map.count', { count: map.length })}</span>
  );

  if (withModels.length < 2 || !source) {
    return (
      <Card className="prov-card" title={<span className="prov-card-title" id="prov-map-title"><Shuffle {...ICON_SM} />{t('map.title')}</span>} actions={head}>
        <div className="rot-intro">
          {intro}
          <p className="small muted">{t('map.needTwo')}</p>
        </div>
      </Card>
    );
  }

  const targets = withModels.filter((s) => s.id !== source.id);
  const models = offered(catalogOf.get(source.id));
  const waitsOn = (model: string) => waiting.has(`${source.id}\0${model}`) && targets.some((s) => !counterpart(map, { provider: source.id, model }, s.id));
  const waitingModel = models.find((m) => waitsOn(m.value));

  const picker = (
    <div className="map-from">
      <span className="section-label">{t('map.from')}</span>
      {narrow ? (
        <div className="rot-line" role="radiogroup" aria-label={t('map.fromAria')}>
          {withModels.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={s.id === source.id} className={`chip${s.id === source.id ? ' chip-on' : ''}`} onClick={() => setFromId(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      ) : (
        <Segmented
          label={t('map.fromAria')}
          value={source.id}
          onChange={setFromId}
          options={withModels.map((s) => ({ value: s.id, label: <>{s.label} <span className="mono small muted">{offered(catalogOf.get(s.id)).length}</span></> }))}
        />
      )}
      {!narrow && <span className="mono small muted push-right">{t('map.savedNow')}</span>}
    </div>
  );
  const callout = waitingModel && (
    <div className="rot-callout is-warn" role="status">
      <TriangleAlert {...ICON_SM} />
      <span>
        <b>{t('map.waitingTitle')}</b> {t('map.waitingBody', { model: waitingModel.label ?? waitingModel.value })}
      </span>
    </div>
  );

  /** What stands in the cell of one model and one target: the counterpart, its suggestion, or the lack of both. */
  const cell = (m: ModelOption, target: ProviderStatus) => {
    const from = { provider: source.id, model: m.value };
    const entry = counterpart(map, from, target.id);
    const suggestion = entry ? undefined : suggestionFor(from, target.id);
    const catalog = catalogOf.get(target.id);
    const stale = entry ? isStale(entry, catalog) : false;
    const name = `${m.label ?? m.value} → ${target.label}`;
    if (suggestion && !entry) {
      return (
        <div className="map-suggest" role="group" aria-label={t('map.suggestionFor', { name })}>
          <div className="rot-line">
            <span className="mono">{modelName(target.id, suggestion.to.model)}</span>
            <Tag tone="project">{t('map.suggested')}</Tag>
          </div>
          <span className="small muted">{t('map.notInForce')}</span>
          <div className="rot-line">
            <button type="button" className="btn btn-small" disabled={answer.isPending} onClick={() => answer.mutate({ id: suggestion.id, accept: true })}>
              {t('map.accept')}
            </button>
            <button type="button" className="btn prov-quiet btn-small" disabled={answer.isPending} onClick={() => answer.mutate({ id: suggestion.id, accept: false })}>
              {t('map.dismiss')}
            </button>
          </div>
        </div>
      );
    }
    const options = offered(catalog).map((o) => ({ value: o.value, label: <span className="mono">{o.label ?? o.value}</span> }));
    // A counterpart that left the catalog stays visible, so it can be read and changed
    if (entry && !options.some((o) => o.value === entry.to.model)) options.unshift({ value: entry.to.model, label: <span className="mono">{entry.to.model}</span> });
    return (
      <div className="map-cell">
        <Select
          value={entry?.to.model ?? NONE}
          aria-label={t('map.counterpartAria', { name })}
          placeholder={t('map.choose')}
          onChange={(v) => set(from, target.id, v === NONE ? null : v)}
          options={[{ value: NONE, label: t('map.none') }, ...options]}
        />
        {!entry && <Tag tone="warn">{t('map.noCounterpart')}</Tag>}
        {stale && <Tag tone="warn">{t('map.stale')}</Tag>}
        {!entry && <span className="small muted">{t('map.waitsHere')}</span>}
        {stale && <span className="small muted">{t('map.staleHint', { provider: target.label })}</span>}
      </div>
    );
  };

  if (narrow) {
    return (
      <>
        <section className="map-phone" aria-labelledby="prov-map-title">
          <h2 className="section-label" id="prov-map-title">{t('map.title')}</h2>
          {intro}
          {callout}
          {picker}
          {models.map((m) => (
            <div className="rot-col" key={m.value}>
              <div className="rot-line">
                <span>{m.label ?? m.value}</span>
                {m.tier && <span className="mono small muted grow">{t(`map.tier.${m.tier}`)}</span>}
                {waitsOn(m.value) && <Tag tone="warn">{t('map.askedByJob')}</Tag>}
              </div>
              <div className="card">
                {targets.map((target) => {
                  const from = { provider: source.id, model: m.value };
                  const entry = counterpart(map, from, target.id);
                  const suggestion = entry ? undefined : suggestionFor(from, target.id);
                  if (suggestion) return <div className="rot-cell stacked" key={target.id}><span>{target.label}</span>{cell(m, target)}</div>;
                  return (
                    <button key={target.id} type="button" className="rot-cell" onClick={() => setPair({ from, target: target.id })}>
                      <span className="grow">{target.label}</span>
                      {entry ? <span className="mono">{entry.to.model}</span> : <Tag tone="warn">{t('map.noCounterpart')}</Tag>}
                      {entry && isStale(entry, catalogOf.get(target.id)) && <Tag tone="warn">{t('map.stale')}</Tag>}
                      <ChevronRight {...ICON_SM} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
        {pair && (
          <PairSheet
            pair={pair}
            title={t('map.pairTitle', { model: modelName(pair.from.provider, pair.from.model), provider: label(pair.target) })}
            catalog={offered(catalogOf.get(pair.target))}
            current={counterpart(map, pair.from, pair.target)?.to.model ?? null}
            onClose={() => setPair(null)}
            onPick={(model) => {
              set(pair.from, pair.target, model);
              setPair(null);
            }}
          />
        )}
      </>
    );
  }

  return (
    <Card className="prov-card" title={<span className="prov-card-title" id="prov-map-title"><Shuffle {...ICON_SM} />{t('map.title')}</span>} actions={head}>
      <div className="rot-intro">
        {intro}
        {picker}
        {callout}
      </div>
      <div className="map-grid" style={{ '--targets': targets.length } as React.CSSProperties}>
        <div className="map-row map-head">
          <span className="section-label">{t('map.modelOf', { provider: source.label })}</span>
          {targets.map((target) => (
            <span className="section-label" key={target.id}>{t('map.equalsIn', { provider: target.label })}</span>
          ))}
        </div>
        {models.map((m) => (
          <div className={`map-row${waitsOn(m.value) ? ' is-target' : ''}`} key={m.value} data-model={m.value}>
            <div className="map-model">
              <span className="map-model-name">{m.label ?? m.value}</span>
              {m.tier && <span className="mono small muted">{t(`map.tier.${m.tier}`)}</span>}
              {waitsOn(m.value) && <Tag tone="warn">{t('map.askedByJob')}</Tag>}
            </div>
            {targets.map((target) => (
              <div className="map-cell-wrap" key={target.id}>{cell(m, target)}</div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Phone: one counterpart, picked from the target's models in a sheet. Nothing is saved until the pick. */
function PairSheet({
  pair,
  title,
  catalog,
  current,
  onClose,
  onPick,
}: {
  pair: Pair;
  title: string;
  catalog: ModelOption[];
  current: string | null;
  onClose: () => void;
  onPick: (model: string | null) => void;
}) {
  const { t } = useTranslation('providers');
  const [choice, setChoice] = useState<string | null>(current);
  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={title}
      description={current === null ? t('map.waitsHere') : undefined}
      side="bottom"
      className="prov-sheet"
      footer={
        <button type="button" className="btn btn-primary" onClick={() => onPick(choice)}>
          {t('map.save')}
        </button>
      }
    >
      <div className="card" role="radiogroup" aria-label={t('map.pickAria')}>
        {catalog.map((m) => (
          <button key={m.value} type="button" className="rot-radio" role="radio" aria-checked={choice === m.value} onClick={() => setChoice(m.value)}>
            <span className={`prov-radio${choice === m.value ? ' on' : ''}`} />
            <span className="rot-col grow">
              <span className="mono">{m.label ?? m.value}</span>
              {m.tier && <span className="small muted">{t(`map.tier.${m.tier}`)}</span>}
            </span>
          </button>
        ))}
        <button type="button" className="rot-radio" role="radio" aria-checked={choice === null} onClick={() => setChoice(null)}>
          <span className={`prov-radio${choice === null ? ' on' : ''}`} />
          <span className="rot-col grow">
            <span>{t('map.none')}</span>
            <span className="small muted">{t('map.noneHint')}</span>
          </span>
        </button>
      </div>
    </Sheet>
  );
}
