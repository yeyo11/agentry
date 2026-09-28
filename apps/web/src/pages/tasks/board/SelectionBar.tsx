import type { WorkItem } from '@agentry/shared';
import { useMutation } from '@tanstack/react-query';
import { CircleSlash, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../api';
import { ICON_SM } from '../../../components/icons';
import { useToast } from '../../../components/Toast';
import { blocksWithin } from './model';

/**
 * "Orchestrate" on a selection: the API drafts a graph (one node per item, `dependsOn` from the
 * blocks among them) and the orchestration editor opens it for review, as the contract between the
 * web tasks says: `navigate('/orchestration', { state: { workItemDraft } })`. Nothing is launched here.
 */
export function useOrchestrateSelection(projectId: string | null, selected: readonly WorkItem[]) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation('tasks');
  return useMutation({
    mutationFn: () => api.orchestrateWorkItems(projectId ?? selected[0]?.projectId ?? '', { itemIds: selected.map((item) => item.id) }),
    onSuccess: (workItemDraft) => navigate('/orchestration', { state: { workItemDraft } }),
    onError: (error) => toast.error(t('select.failed'), error),
  });
}

/**
 * Floats over the board while cards are chosen: how many, which of them blocks which (the order the
 * graph will keep), Cancel, and "Orchestrate", the zone's one primary action.
 */
export function SelectionBar({ projectId, selected, onCancel }: { projectId: string | null; selected: readonly WorkItem[]; onCancel: () => void }) {
  const { t } = useTranslation('tasks');
  const orchestrate = useOrchestrateSelection(projectId, selected);
  const pairs = blocksWithin(selected);
  return (
    <div className="selection-bar" role="toolbar" aria-label={t('select.bar')}>
      <span className="selection-bar-count" role="status">
        {selected.length > 0 ? t('select.count', { count: selected.length }) : t('select.none')}
      </span>
      {pairs.map((pair) => (
        <span key={`${pair.blocker}>${pair.blocked}`} className="selection-bar-rel">
          <CircleSlash size={12} strokeWidth={1.75} aria-hidden />
          {t('select.blocks', pair)}
        </span>
      ))}
      <span className="selection-bar-sep" aria-hidden />
      <button type="button" className="btn btn-small selection-bar-cancel" onClick={onCancel}>
        {t('select.cancel')}
      </button>
      <button type="button" className="btn btn-small btn-primary" disabled={selected.length === 0 || orchestrate.isPending} onClick={() => orchestrate.mutate()}>
        <Workflow {...ICON_SM} />
        {t('select.orchestrate')}
      </button>
    </div>
  );
}

/** The phone's version: a bottom bar with the figures and "Orchestrate" across it, and the note above. */
export function PhoneSelectionFoot({ projectId, selected }: { projectId: string | null; selected: readonly WorkItem[] }) {
  const { t } = useTranslation('tasks');
  const orchestrate = useOrchestrateSelection(projectId, selected);
  return (
    <div className="selection-foot" role="toolbar" aria-label={t('select.bar')}>
      <span className="selection-foot-figures" role="status">
        <b>{t('select.tasks', { count: selected.length })}</b>
        <span className="mono">{t('select.nodes', { count: selected.length })}</span>
      </span>
      <button type="button" className="btn btn-primary" disabled={selected.length === 0 || orchestrate.isPending} onClick={() => orchestrate.mutate()}>
        <Workflow {...ICON_SM} />
        {t('select.orchestrate')}
      </button>
    </div>
  );
}

/** What the phone says above its bottom bar: each chosen task becomes a node, and who waits for whom. */
export function SelectionNote({ selected }: { selected: readonly WorkItem[] }) {
  const { t } = useTranslation('tasks');
  if (selected.length === 0) return null;
  return (
    <div className="card selection-note">
      <Workflow {...ICON_SM} />
      <p>
        {t('select.explain')}
        {blocksWithin(selected).map((pair) => (
          <span key={`${pair.blocker}>${pair.blocked}`}> {t('select.explainBlocks', pair)}</span>
        ))}
      </p>
    </div>
  );
}
