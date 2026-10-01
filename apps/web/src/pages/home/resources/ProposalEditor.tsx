import type { AssistantResourceProposal, AssistantRun, ConfigScopeKind } from '@agentry/shared';
import { RESOURCE_FORMATS } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Folder, User } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { AssistantMark, RunFacts } from '../../../components/assistant/run';
import { CodeEditor } from '../../../components/CodeEditor';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { Segmented, Tag } from '@agentry/ui/components/ui';
import { useDirty } from '../../../lib/dirty';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { shortcut } from '../../../lib/shortcut';
import { frontmatterProblem } from '../../config/frontmatter';
import { RESOURCE_NAME } from '../../config/ResourcesTab';
import { savePath, shownName } from './model';
import { freeName, renamedContent, useTakenNames } from './names';

/**
 * A proposed resource opened in the editor before it exists (decision 37): its content as the
 * assistant wrote it, editable, the scope it goes to (the project unless the person picks the user),
 * and why it was proposed. Saving it is accepting it, and nothing is written before; "Discard" sets
 * it aside, and it can be restored from the proposals.
 */
export function ProposalEditor({
  projectId,
  proposal,
  run,
  initialScope,
  onSaved,
  onDiscarded,
}: {
  projectId: string;
  proposal: AssistantResourceProposal;
  /** The run that proposed it, for its facts; null while it loads */
  run: AssistantRun | null;
  /** The scope "Create with AI" chose, which the editor starts on */
  initialScope?: ConfigScopeKind | undefined;
  onSaved: (name: string) => void;
  onDiscarded: () => void;
}) {
  const { t } = useTranslation('config');
  const toast = useToast();
  const queryClient = useQueryClient();
  const phone = useMediaQuery(NARROW);
  const { resource } = proposal;
  const [content, setContent] = useState(resource.content);
  const [scope, setScope] = useState<ConfigScopeKind>(initialScope ?? resource.scope);
  const pending = proposal.status === 'pending';
  const taken = useTakenNames(projectId, resource.kind, scope);
  // Until the person types one, the name follows the scope: the proposed one, or the first free after it
  const [typed, setTyped] = useState<string | null>(null);
  const fileName = pending ? (typed ?? freeName(resource.name, taken)) : resource.name;
  const nameProblem = !pending ? null : !RESOURCE_NAME.test(fileName) ? 'nameRule' : taken.has(fileName) ? 'exists' : null;
  const name = shownName(resource.kind, fileName);
  // Only what the person typed is lost by leaving: the proposal itself stays, pending
  useDirty(`proposal:${proposal.id}`, pending && content !== resource.content);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.assistantRun(proposal.runId) });
    void queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(projectId) });
  };
  const save = useMutation({
    mutationFn: () =>
      api.acceptAssistantProposal(proposal.id, {
        resource: { ...(fileName !== resource.name ? { name: fileName } : {}), content: renamedContent(content, resource.name, fileName), scope },
      }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: keys.resources(scope === 'project' ? { projectId } : {}, resource.kind) });
      toast.success(t(`resources.kinds.${resource.kind}.saved`, { name: fileName }), savePath(resource.kind, fileName, scope));
      onSaved(fileName);
    },
    onError: (err) => toast.error(t(`resources.kinds.${resource.kind}.saveFailed`), err),
  });
  const discard = useMutation({
    mutationFn: () => api.discardAssistantProposal(proposal.id),
    onSuccess: () => {
      refresh();
      onDiscarded();
    },
    onError: (err) => toast.error(t('resourcesAi.decideFailed'), err),
  });
  const problem = pending ? frontmatterProblem(resource.kind, content) : null;
  const blocked = problem !== null || nameProblem !== null;
  const trySave = () => pending && !blocked && !save.isPending && save.mutate();

  return (
    <div className={`form resource-proposal-editor${phone ? ' is-phone' : ''}`}>
      <div className="editor-meta">
        {pending ? (
          <input
            className={`mono resource-proposal-name-input ${nameProblem ? 'is-invalid' : ''}`.trim()}
            value={fileName}
            aria-label={t(`resources.kinds.${resource.kind}.nameLabel`)}
            aria-invalid={nameProblem !== null}
            onChange={(e) => setTyped(e.target.value.trim())}
          />
        ) : (
          <strong className="mono resource-proposal-name">{name}</strong>
        )}
        <Tag>{t(`resourcesAi.kind.${resource.kind}`)}</Tag>
        {pending && <Tag tone="warn">{t('resources.notSavedYet')}</Tag>}
        <span className="path grow">{t(scope === 'project' ? 'resourcesAi.willSave' : 'resourcesAi.willSaveUser', { path: savePath(resource.kind, fileName, scope) })}</span>
        {pending && (
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
        )}
      </div>

      {nameProblem && (
        <span className="field-error" role="alert">
          {t(`resources.${nameProblem}`)}
        </span>
      )}

      {proposal.reason && (
        <div className="resource-proposal-why">
          <AssistantMark small />
          <div className="resource-proposal-why-text">
            <span className="strong">{t('resourcesAi.proposedBy')}</span>
            <span className="muted">{proposal.reason}</span>
            {run && <RunFacts run={run} label={run.description === null ? t('resourcesAi.suggest') : t('resourcesAi.createAi')} />}
          </div>
        </div>
      )}

      <CodeEditor
        language={RESOURCE_FORMATS[resource.kind]}
        ariaLabel={t(`resources.kinds.${resource.kind}.content`)}
        minHeight="380px"
        value={content}
        onChange={setContent}
        onSave={trySave}
        readOnly={!pending}
      />
      {problem && (
        <span className="field-error" role="alert">
          {t(`resources.frontmatter.${problem}`)}
        </span>
      )}

      <div className="form-actions resource-proposal-actions">
        {pending ? (
          <>
            <button type="button" className="btn btn-primary" disabled={save.isPending || blocked} onClick={() => save.mutate()}>
              <Check {...ICON_SM} />
              {save.isPending ? t('shared.saving') : t(`resources.kinds.${resource.kind}.create`)}
            </button>
            <button type="button" className="btn" disabled={discard.isPending} onClick={() => discard.mutate()}>
              {t('resourcesAi.discard')}
            </button>
            <span className="form-hint push-right resource-proposal-hint">
              {t('resourcesAi.nothingWritten')} <kbd className="palette-kbd">{shortcut('S')}</kbd>
            </span>
          </>
        ) : (
          <span className="form-hint">{proposal.status === 'accepted' ? t('resourcesAi.alreadySaved') : t('resourcesAi.alreadyDiscarded')}</span>
        )}
      </div>
    </div>
  );
}
