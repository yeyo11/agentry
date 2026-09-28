import type { AssistantResourceKind, AssistantResourceProposal, ConfigScopeKind, Project } from '@agentry/shared';
import { RESOURCE_FORMATS } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Folder, RefreshCw, Sparkle, User, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useAssistantRun, useAssistantRuns } from '../../../api';
import { AssistantMark, RunFacts, SuggestionWait, useElapsed } from '../../../components/assistant/run';
import { ActivityTicker } from '../../../components/ActivityTicker';
import { CodeEditor } from '../../../components/CodeEditor';
import { Dialog } from '../../../components/Dialog';
import { ICON_SM } from '../../../components/icons';
import { useToast } from '../../../components/Toast';
import { Segmented } from '../../../components/ui';
import { NARROW, useMediaQuery } from '../../../lib/media';
import { localized } from '../../../lib/server-strings';
import { FullScreen } from '../../tasks/FullScreen';
import { AI_KINDS, savePath } from './model';
import { freeName, useTakenNames } from './names';
import { KindIcon } from './parts';

/**
 * "Create with AI" (decision 37): the person says what one agent, skill or command should do, and a
 * `resources` run of the assistant writes it, read-only, fitted to the project. Nothing is saved:
 * "Open in the editor" opens the proposal unsaved, in the scope chosen here, and saving it there is
 * accepting it. A dialog on a desktop, a full screen on a phone; the run goes on if it is closed.
 */
export function CreateWithAI({
  project,
  initialKind,
  onClose,
  onOpen,
}: {
  project: Pick<Project, 'id' | 'name'>;
  initialKind: AssistantResourceKind;
  onClose: () => void;
  onOpen: (proposal: AssistantResourceProposal, scope: ConfigScopeKind) => void;
}) {
  const { t } = useTranslation('config');
  const phone = useMediaQuery(NARROW);
  const toast = useToast();
  const queryClient = useQueryClient();
  const descriptionId = useId();
  const [kind, setKind] = useState<AssistantResourceKind>(initialKind);
  const [scope, setScope] = useState<ConfigScopeKind>('project');
  const [description, setDescription] = useState('');
  const [runId, setRunId] = useState<string | null>(null);

  // A "Create with AI" still running (the dialog was closed, or the page reloaded) is picked up again
  const runs = useAssistantRuns(project.id, 'resources');
  useEffect(() => {
    if (runId) return;
    const going = runs.data?.find((run) => run.status === 'running' && run.description !== null);
    if (going) {
      setRunId(going.id);
      setDescription(going.description ?? '');
      if (going.resourceKind) setKind(going.resourceKind);
    }
  }, [runs.data, runId]);

  const detail = useAssistantRun(runId);
  const run = detail.data && detail.data.id === runId ? detail.data : null;
  const running = run?.status === 'running';
  const proposal = run?.proposals.find((p): p is AssistantResourceProposal => p.kind === 'resource') ?? null;
  // The name it will be saved under: the proposed one, or the first free one where it goes
  const taken = useTakenNames(project.id, proposal?.resource.kind ?? kind, scope);
  const fileName = proposal ? (proposal.status === 'pending' ? freeName(proposal.resource.name, taken) : proposal.resource.name) : null;

  const start = useMutation({
    mutationFn: () => api.startAssistantRun(project.id, { kind: 'resources', description: description.trim(), resourceKind: kind }),
    onSuccess: (started) => {
      queryClient.setQueryData(keys.assistantRun(started.id), started);
      void queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(project.id) });
      setRunId(started.id);
    },
    onError: (err) => toast.error(t('resourcesAi.startFailed'), err),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopAssistantRun(id),
    onSuccess: (stopped) => queryClient.setQueryData(keys.assistantRun(stopped.id), stopped),
    onError: (err) => toast.error(t('resourcesAi.stopFailed'), err),
  });

  const locked = running || start.isPending;
  const finished = run && !running;
  const kindOption = (value: AssistantResourceKind) => ({
    value,
    label: (
      <span className="resource-scope-option">
        <KindIcon kind={value} />
        {t(`resourcesAi.kind.${value}`)}
      </span>
    ),
  });
  const form = (
    <>
      <div className="create-ai-pickers">
        <div className="form-row">
          <span className="section-label">{t('resourcesAi.type')}</span>
          <Segmented label={t('resourcesAi.type')} value={kind} onChange={(value) => !locked && setKind(value)} options={AI_KINDS.map(kindOption)} />
        </div>
        <div className="form-row">
          <span className="section-label">{t('resourcesAi.where')}</span>
          <Segmented
            label={t('resourcesAi.where')}
            value={scope}
            onChange={setScope}
            options={[
              {
                value: 'project',
                label: (
                  <span className="resource-scope-option">
                    <Folder {...ICON_SM} />
                    {t('resourcesAi.scope.project')}
                  </span>
                ),
              },
              {
                value: 'user',
                label: (
                  <span className="resource-scope-option">
                    <User {...ICON_SM} />
                    {t('resourcesAi.scope.user')}
                  </span>
                ),
              },
            ]}
          />
        </div>
      </div>
      <div className="form-row">
        <label className="section-label" htmlFor={descriptionId}>
          {t('resourcesAi.what')}
        </label>
        <textarea
          id={descriptionId}
          className="create-ai-description"
          rows={3}
          value={description}
          placeholder={t(`resourcesAi.whatPlaceholder.${kind}`)}
          readOnly={locked}
          data-autofocus
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
    </>
  );

  let result: ReactNode = null;
  if (run && running) result = <LiveWriting run={run} />;
  else if (run && proposal)
    result = (
      <section className="suggestion-run is-done create-ai-result" aria-label={t('resourcesAi.written')}>
        <div className="create-ai-result-head">
          <AssistantMark small />
          <span className="mono create-ai-file">{savePath(proposal.resource.kind, fileName ?? proposal.resource.name, scope)}</span>
          <RunFacts run={run} />
        </div>
        <CodeEditor language={RESOURCE_FORMATS[proposal.resource.kind]} ariaLabel={t(`resources.kinds.${proposal.resource.kind}.content`)} value={proposal.resource.content} readOnly minHeight="160px" maxHeight={phone ? '46vh' : '300px'} />
      </section>
    );
  else if (finished)
    result = (
      <section className="suggestion-run is-done create-ai-result is-failed" aria-label={t('resourcesAi.written')}>
        <AlertTriangle {...ICON_SM} className="text-err" />
        <span className="grow">{run.status === 'stopped' ? t('resourcesAi.stopped') : run.error ? localized(run.error) : t('resourcesAi.failed')}</span>
        <RunFacts run={run} />
      </section>
    );

  const canStart = description.trim().length > 0 && !locked;
  const primary =
    proposal && finished ? (
      <button type="button" className="btn btn-primary create-ai-open" onClick={() => onOpen(proposal, scope)}>
        {t('resourcesAi.openInEditor')}
      </button>
    ) : run && !running ? (
      <button type="button" className="btn btn-primary create-ai-start" disabled={!canStart} onClick={() => start.mutate()}>
        <RefreshCw {...ICON_SM} />
        {t('resourcesAi.again')}
      </button>
    ) : running ? (
      <button type="button" className="btn btn-primary create-ai-open" disabled>
        {t('resourcesAi.openInEditor')}
      </button>
    ) : (
      <button type="button" className="btn btn-primary create-ai-start" disabled={!canStart} onClick={() => start.mutate()}>
        <Sparkle {...ICON_SM} />
        {t('resourcesAi.create')}
      </button>
    );
  const secondary =
    running && run ? (
      <button type="button" className="btn create-ai-stop" disabled={stop.isPending} onClick={() => stop.mutate(run.id)}>
        <X {...ICON_SM} />
        {t('resourcesAi.stop')}
      </button>
    ) : !phone ? (
      <button type="button" className="btn btn-quiet" onClick={onClose}>
        {t('resourcesAi.cancel')}
      </button>
    ) : null;

  if (phone)
    return (
      <FullScreen
        title={t('resourcesAi.createAi')}
        onClose={onClose}
        footer={
          <div className="suggest-mfoot">
            {secondary}
            {primary}
          </div>
        }
      >
        <div className="create-ai-body is-phone">
          {form}
          {result}
        </div>
      </FullScreen>
    );

  return (
    <Dialog
      width={700}
      onClose={onClose}
      title={
        <span className="suggest-dialog-title">
          <AssistantMark small />
          <span className="grow">{t('resourcesAi.createAi')}</span>
          <span className="mono small muted">{project.name}</span>
        </span>
      }
      footer={
        <>
          <span className="form-hint grow">{t('resourcesAi.createHint')}</span>
          {secondary}
          {primary}
        </>
      }
    >
      <div className="create-ai-body">
        {form}
        {result}
      </div>
    </Dialog>
  );
}

/** The run writing the resource: the live verb and the time, its facts, and the still slot its file will fill. */
function LiveWriting({ run }: { run: NonNullable<ReturnType<typeof useAssistantRun>['data']> }) {
  const { t } = useTranslation('config');
  const elapsed = useElapsed(run.startedAt, true);
  const activity = run.activity ?? { kind: 'thinking' as const, since: run.startedAt };
  return (
    <section className="suggestion-run is-live live-energy create-ai-live" aria-label={t('resourcesAi.writing')}>
      <div className="create-ai-now">
        <ActivityTicker activity={activity} showElapsed={false} />
        <span className="grow" />
        <span className="mono small muted tabular">{elapsed}</span>
      </div>
      <RunFacts run={run} />
      <SuggestionWait>{t('resourcesAi.contentWait')}</SuggestionWait>
    </section>
  );
}
