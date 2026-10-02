import type { Project, TrackerId, TrackerMappedStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CircleOff } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { WorkItemStatusIcon } from '../../components/work-item-icons';
import { Select, Sheet } from '@agentry/ui/components/controls';
import { ICON_SM, Monogram } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox, Skeleton, Tag } from '@agentry/ui/components/ui';
import { useDirty } from '../../lib/dirty';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { issueRef, MAPPED_COLUMNS, statusChoices, TRACKER_IDS, trackerEntry, trackerWords } from '../../lib/trackers';
import { canSaveDraft, chooseTracker, draftOf, sameDraft, settingsOf, trackerOptions, withMapped, type TrackerDraft, type TrackerOption } from './project-tracker';

/**
 * The project's issue tracker: which of the ready trackers its tasks link with, the scope and the
 * query the import starts from, and what moving a task writes back. Saved through
 * `PUT /projects/:id/tracker`, which replaces only the tracker of the settings document.
 */
export function ProjectTracker({ project }: { project: Project }) {
  const { t } = useTranslation(['projects', 'tasks']);
  const narrow = useMediaQuery(NARROW);
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ queryKey: keys.projectTracker(project.id), queryFn: ({ signal }) => api.projectTracker(project.id, { signal }) });
  const statuses = useQuery({ queryKey: keys.trackers, queryFn: ({ signal }) => api.trackers({ signal }) });
  const settings = useQuery({ queryKey: keys.trackerSettings, queryFn: ({ signal }) => api.trackerSettings({ signal }) });
  const host = useQuery({ queryKey: keys.projectCodeHost(project.id), queryFn: ({ signal }) => api.projectCodeHost(project.id, { signal }) });

  const base = draftOf(saved.data);
  const [edit, setEdit] = useState<{ from: typeof saved.data; draft: TrackerDraft } | null>(null);
  // What was saved elsewhere shows here unless the person edited: an edit made on an older document is dropped
  const draft = edit && edit.from === saved.data ? edit.draft : base;
  const change = (next: TrackerDraft) => setEdit({ from: saved.data, draft: next });
  const dirty = !sameDraft(draft, base);
  useDirty('project-tracker', dirty);
  const [open, setOpen] = useState(false);

  const save = useMutation({
    mutationFn: () => api.putProjectTracker(project.id, settingsOf(draft)),
    onSuccess: () => {
      setEdit(null);
      toast.success(t('tracker.saved'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projectTracker(project.id) });
      void queryClient.invalidateQueries({ queryKey: keys.projectSettings(project.id) });
    },
  });

  if (saved.isLoading || statuses.isLoading || settings.isLoading || host.isLoading) return <Skeleton rows={4} height={18} />;
  if (!saved.isSuccess || !statuses.data) return <ErrorBox error={saved.error ?? statuses.error} title={t('tracker.loadFailed')} />;

  const projectHost = host.data?.readiness.host ?? null;
  const remotePath = host.data?.remote?.path ?? null;
  const options = trackerOptions(statuses.data, TRACKER_IDS, projectHost, (id) => trackerEntry(settings.data, id).enabled);
  const chosen = draft.id;
  const words = chosen ? trackerWords(chosen) : null;
  const chosenCli = chosen ? statuses.data.find((s) => s.id === chosen)?.cli : null;

  const chooser = (
    <div role="radiogroup" aria-label={t('tracker.label')} className="trk-opts">
      {options.map((option) => (
        <TrackerChoice
          key={option.id}
          option={option}
          selected={chosen === option.id}
          cli={option.status.cli}
          hostname={host.data?.remote?.hostname ?? ''}
          onPick={() => change(chooseTracker(draft, option.id, remotePath))}
        />
      ))}
      <button type="button" role="radio" aria-checked={chosen === null} className={`trk-opt${chosen === null ? ' on' : ''}`} onClick={() => change(chooseTracker(draft, null, remotePath))}>
        <span className="trk-none" aria-hidden="true">
          <CircleOff {...ICON_SM} />
        </span>
        <span className="trk-opt-id">
          <span className="trk-opt-name">{t('tracker.none')}</span>
          <span className="trk-opt-why">{t('tracker.noneWhy')}</span>
        </span>
        <span className={`radio${chosen === null ? ' on' : ''}`} aria-hidden="true" />
      </button>
    </div>
  );

  const fields = chosen && words && (
    <>
      <div className="form-row">
        <label className="section-label" htmlFor="project-tracker-scope">
          {t(`tracker.scope.${words.scopeKey === 'scope.project' ? 'project' : 'repository'}`)}
        </label>
        <input id="project-tracker-scope" className="mono" value={draft.scope} placeholder={remotePath ?? ''} onChange={(e) => change({ ...draft, scope: e.target.value })} />
        <span className="form-hint">
          <Trans t={t} i18nKey="tracker.scopeHint" values={{ tracker: words.label }} components={{ mono: <span className="mono" /> }} />
        </span>
      </div>
      <div className="form-row">
        <label className="section-label" htmlFor="project-tracker-query">
          {t('tracker.query')}
        </label>
        <input id="project-tracker-query" className="mono" value={draft.query} placeholder={t(`tracker.queryPlaceholder.${chosen}`, { defaultValue: '' })} onChange={(e) => change({ ...draft, query: e.target.value })} />
        <span className="form-hint">{t(`tracker.queryHint.${chosen}`, { defaultValue: t('tracker.queryHintDefault', { tracker: words.label }) })}</span>
      </div>
      <div className="form-row">
        <span className="section-label" id="project-tracker-map">
          {t('tracker.map')}
        </span>
        <div className="trk-map" role="group" aria-labelledby="project-tracker-map">
          {MAPPED_COLUMNS.map((column) => (
            <MapRow key={column} tracker={chosen} column={column} value={draft.statusMap[column] ?? ''} onChange={(value) => change(withMapped(draft, column, value))} />
          ))}
        </div>
        <span className="form-hint">
          <Trans
            t={t}
            i18nKey="tracker.mapHint"
            values={{ ref: issueRef(chosen, '12'), cli: chosenCli ?? '' }}
            components={{ mono: <span className="mono" /> }}
          />
        </span>
      </div>
    </>
  );

  const body = (
    <div className="project-tracker-body">
      <div className="form-row">
        <span className="section-label">{t('tracker.label')}</span>
        {chooser}
        <span className="form-hint">{t('tracker.chooseHint')}</span>
      </div>
      {fields}
      <ErrorBox error={save.error} title={t('tracker.saveFailed')} />
    </div>
  );

  const actions = (
    <div className="project-general-actions">
      {!narrow && (
        <button type="button" className="btn btn-quiet" disabled={!dirty || save.isPending} onClick={() => setEdit(null)}>
          {t('general.discard')}
        </button>
      )}
      <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending || !canSaveDraft(draft)} onClick={() => save.mutate()}>
        {save.isPending ? t('general.saving') : t('general.save')}
      </button>
    </div>
  );

  if (narrow) {
    return (
      <>
        <button type="button" className="settings-cell project-limits-cell" onClick={() => setOpen(true)}>
          <span className="settings-cell-name project-limits-text">
            <span>{t('tracker.title')}</span>
            <span className="mono small muted">{saved.data ? `${trackerWords(saved.data.id).label} · ${saved.data.scope}` : t('tracker.summaryNone')}</span>
          </span>
          <ChevronRight {...ICON_SM} className="settings-cell-chevron" />
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={t('tracker.title')} description={t('tracker.intro')} side="bottom" footer={actions}>
          {body}
        </Sheet>
      </>
    );
  }

  return (
    <section className="card project-tracker-card" aria-labelledby="project-tracker-title">
      <div className="card-head">
        <h2 id="project-tracker-title">{t('tracker.title')}</h2>
        <span className="mono small muted">{t('tracker.optional')}</span>
      </div>
      <p className="small muted">{t('tracker.intro')}</p>
      {body}
      {actions}
    </section>
  );
}

function TrackerChoice({ option, selected, cli, hostname, onPick }: { option: TrackerOption; selected: boolean; cli: string; hostname: string; onPick: () => void }) {
  const { t } = useTranslation('projects');
  const words = trackerWords(option.id);
  const reason = t(`tracker.reason.${option.reason}`, { cli, tracker: words.label, hostname: hostname || t('tracker.thisHost') });
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={!option.choosable}
      className={`trk-opt${selected ? ' on' : ''}`}
      onClick={() => option.choosable && onPick()}
    >
      <Monogram name={words.label} project size={36} />
      <span className="trk-opt-id">
        <span className="trk-opt-name">
          {words.label}
          <Tag tone={option.tone}>{t(`tracker.state.${option.stateKey}`)}</Tag>
        </span>
        <span className="trk-opt-why">{reason}</span>
      </span>
      <span className={`radio${selected ? ' on' : ''}`} aria-hidden="true" />
    </button>
  );
}

/** One column: Done closes the issue on the two built trackers; the others are saved but written nowhere, and say so. */
function MapRow({ tracker, column, value, onChange }: { tracker: TrackerId; column: TrackerMappedStatus; value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation(['projects', 'tasks']);
  const choices = statusChoices(tracker, column);
  const name = t(`tasks:status.${column}`);
  return (
    <div className="trk-map-row">
      <span className="trk-map-col">
        <WorkItemStatusIcon status={column} decorative />
        {name}
      </span>
      <ChevronRight {...ICON_SM} className="ico" aria-hidden />
      <span className="trk-sel">
        <Select
          aria-label={t('tracker.statusOf', { column: name })}
          value={choices.length ? value : ''}
          disabled={choices.length === 0}
          onChange={onChange}
          options={[
            ...choices.map((choice) => ({ value: choice, label: t(`tracker.choice.${choice}`, { defaultValue: choice }) })),
            { value: '', label: t('tracker.unchanged') },
          ]}
        />
      </span>
      {choices.length === 0 && <span className="trk-map-note">{t('tracker.onlyOpenClosed', { tracker: trackerWords(tracker).label })}</span>}
    </div>
  );
}
