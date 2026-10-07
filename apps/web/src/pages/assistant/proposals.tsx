import type { AssistantProposal, AssistantResourceProposal, AssistantTeamMemberProposal, AssistantWorkItemProposal } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Package, SquareCheck, Undo2, Users, X, Zap, Terminal, SquareSlash, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { EffortTag } from '../../components/EffortPicker';
import { ProposedWorkItemMeta } from '../../components/assistant/run';
import { DecisionMark } from '../../components/DecisionMark';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { WorkItemKey } from '../../components/work-item-icons';
import { useToast } from '@agentry/ui/components/Toast';
import { ModelTag, RoleAvatar, useRoleName } from '../team/RoleAvatar';
import { resourceReviewHref } from './model';

/** Accept, discard and restore, each on its own (decision 36); the run is read again once it answers. */
export function useDecide(runId: string) {
  const { t } = useTranslation('assistant');
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ proposal, action }: { proposal: AssistantProposal; action: 'accept' | 'discard' | 'restore' }) =>
      action === 'accept'
        ? api.acceptAssistantProposal(proposal.id)
        : action === 'discard'
          ? api.discardAssistantProposal(proposal.id)
          : api.restoreAssistantProposal(proposal.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.assistantRun(runId) }),
    onError: (error) => toast.error(t('proposal.failed'), error),
  });
}

type Decide = ReturnType<typeof useDecide>;

/** The icon a section or a proposed resource is known by. */
export const SECTION_ICON = { team: Users, resources: Package, tasks: SquareCheck } as const;
const RESOURCE_ICON = { agents: Terminal, skills: Zap, commands: SquareSlash } as const;

/** A card's head: its icon, its name, the tally in mono, and a note at its right. */
export function SectionHead({ section, tally, note }: { section: keyof typeof SECTION_ICON; tally?: ReactNode; note?: ReactNode }) {
  const { t } = useTranslation('assistant');
  const Icon = SECTION_ICON[section];
  return (
    <div className="card-head assistant-card-head">
      <Icon {...ICON} className="muted" />
      <h2>{t(`section.${section}`)}</h2>
      <span className="mono small muted grow">{tally}</span>
      {note && <span className="small muted">{note}</span>}
    </div>
  );
}

/**
 * The actions of a proposal: Discard and Accept while it waits (Review for a resource, whose editor
 * is its accept), what it became once accepted, and Undo once discarded.
 */
function Actions({ proposal, name, decide, done, primary, phone }: { proposal: AssistantProposal; name: string; decide: Decide; done: ReactNode; primary?: ReactNode; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const busy = decide.isPending && decide.variables?.proposal.id === proposal.id;
  if (proposal.status === 'accepted') return <span className="suggestion-done">{done}</span>;
  if (proposal.status === 'discarded')
    return (
      <div className="suggestion-acts">
        <span className="small muted">{t('proposal.discarded')}</span>
        <button type="button" className="btn btn-quiet btn-small" disabled={busy} aria-label={t('proposal.undoNamed', { name })} onClick={() => decide.mutate({ proposal, action: 'restore' })}>
          <Undo2 {...ICON_SM} />
          {t('proposal.undo')}
        </button>
      </div>
    );
  return (
    <div className="suggestion-acts">
      <button type="button" className="btn btn-quiet btn-small" disabled={busy} aria-label={t('proposal.discardNamed', { name })} onClick={() => decide.mutate({ proposal, action: 'discard' })}>
        <X {...ICON_SM} />
        {t('proposal.discard')}
      </button>
      {primary ?? (
        <button type="button" className={phone ? 'btn' : 'btn btn-small'} disabled={busy} aria-label={t('proposal.acceptNamed', { name })} onClick={() => decide.mutate({ proposal, action: 'accept' })}>
          <Check {...ICON_SM} />
          {t('proposal.accept')}
        </button>
      )}
    </div>
  );
}

const rowClass = (proposal: AssistantProposal, phone: boolean, compact = false) =>
  [phone ? 'suggestion-card' : 'suggestion-row', compact && !phone ? 'is-compact' : '', proposal.status === 'accepted' ? 'is-accepted' : '', proposal.status === 'discarded' ? 'is-discarded' : '']
    .filter(Boolean)
    .join(' ');

/** A proposed work item: its title, type, priority and labels, and the reason quoted under them. */
export function WorkItemProposalRow({ proposal, decide, phone }: { proposal: AssistantWorkItemProposal; decide: Decide; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const item = proposal.workItem;
  const done = (
    <>
      <Check {...ICON_SM} />
      {proposal.created ? (
        <>
          {t('tasks.created')} ·{' '}
          <Link to={`/tasks/${encodeURIComponent(proposal.created.key)}`} title={proposal.created.title}>
            <WorkItemKey value={proposal.created.key} boxed />
          </Link>
        </>
      ) : (
        t('tasks.gone')
      )}
    </>
  );
  const actions = <Actions proposal={proposal} name={item.title} decide={decide} done={done} phone={phone} />;
  return (
    <li className={rowClass(proposal, phone)} data-proposal={proposal.id} data-status={proposal.status}>
      <div className="suggestion-main">
        <span className="suggestion-title">{item.title}</span>
        <DecisionMark subjectKind="assistant_run" subjectId={proposal.runId} />
        <ProposedWorkItemMeta item={item} />
        {proposal.reason && <p className="suggestion-reason">{proposal.reason}</p>}
      </div>
      {actions}
    </li>
  );
}

/** A proposed member: its role, its model and what it may write. */
export function MemberProposalRow({ proposal, decide, phone, compact = false }: { proposal: AssistantTeamMemberProposal; decide: Decide; phone: boolean; compact?: boolean }) {
  const { t } = useTranslation('assistant');
  const roleName = useRoleName();
  const member = proposal.member;
  const name = roleName(member.role);
  const done = (
    <>
      <Check {...ICON_SM} />
      {phone ? t('team.addedWhere') : t('team.added')}
    </>
  );
  const writes = member.writes.length > 0 ? member.writes.join(', ') : t('team.writesNothing');
  const meta = (
    <div className="suggestion-meta">
      <ModelTag model={member.model} />
      <EffortTag effort={member.effort} recommended />
      {!compact && (
        <>
          {!phone && <span aria-hidden>·</span>}
          <span>
            {t('team.writes')} <span className="mono">{writes}</span>
          </span>
        </>
      )}
    </div>
  );
  const title = (
    <span className="suggestion-title">
      {name}
      {!member.fromTemplate && <span className="badge">{t('team.outside')}</span>}
    </span>
  );
  if (phone && compact) {
    // The empty project's template roles on a phone: one line each, the X as the discard
    const busy = decide.isPending && decide.variables?.proposal.id === proposal.id;
    return (
      <li className={`${rowClass(proposal, false, true)} assistant-member-compact`} data-proposal={proposal.id} data-status={proposal.status}>
        <RoleAvatar role={member.role} />
        <div className="suggestion-main">
          {title}
          {meta}
        </div>
        {proposal.status === 'pending' ? (
          <div className="suggestion-acts">
            <button type="button" className="icon-btn assistant-discard-icon" disabled={busy} aria-label={t('proposal.discardNamed', { name })} onClick={() => decide.mutate({ proposal, action: 'discard' })}>
              <X {...ICON} />
            </button>
            <button type="button" className="btn" disabled={busy} aria-label={t('proposal.acceptNamed', { name })} onClick={() => decide.mutate({ proposal, action: 'accept' })}>
              <Check {...ICON_SM} />
              {t('proposal.accept')}
            </button>
          </div>
        ) : (
          <Actions proposal={proposal} name={name} decide={decide} done={done} phone />
        )}
      </li>
    );
  }
  if (phone)
    return (
      <li className={`${rowClass(proposal, true)} assistant-member-card`} data-proposal={proposal.id} data-status={proposal.status}>
        <div className="assistant-member-line">
          <RoleAvatar role={member.role} />
          <div className="suggestion-main">
            {title}
            {meta}
          </div>
        </div>
        <Actions proposal={proposal} name={name} decide={decide} done={done} phone />
      </li>
    );
  return (
    <li className={rowClass(proposal, false, true)} data-proposal={proposal.id} data-status={proposal.status}>
      <RoleAvatar role={member.role} />
      <div className="suggestion-main">
        {title}
        {meta}
      </div>
      <Actions proposal={proposal} name={name} decide={decide} done={done} phone={false} />
    </li>
  );
}

/** A proposed agent, skill or command: accepting it is saving it from the editor, so "Review" opens it there. */
export function ResourceProposalRow({ proposal, projectId, decide, phone }: { proposal: AssistantResourceProposal; projectId: string; decide: Decide; phone: boolean }) {
  const { t } = useTranslation('assistant');
  const resource = proposal.resource;
  const Icon = RESOURCE_ICON[resource.kind];
  const name = resource.kind === 'commands' ? `/${resource.name}` : resource.name;
  const done = (
    <>
      <Check {...ICON_SM} />
      {t('resources.savedDone')}
      {phone && proposal.saved && <span className="ellipsis"> · {proposal.saved.path}</span>}
    </>
  );
  const review = (
    <Link to={resourceReviewHref(projectId, proposal)} className="btn btn-small" aria-label={t('resources.reviewNamed', { name })}>
      <Pencil {...ICON_SM} />
      {t('resources.review')}
    </Link>
  );
  const accepted = proposal.status === 'accepted';
  return (
    <li className={rowClass(proposal, phone)} data-proposal={proposal.id} data-status={proposal.status}>
      <div className={phone ? 'assistant-member-line' : 'assistant-resource-lead'}>
        <span className="link-ico" role="img" aria-label={t(`resources.kind.${resource.kind}`)}>
          <Icon {...ICON_SM} />
        </span>
        {phone && (
          <div className="suggestion-main">
            <span className="suggestion-title">
              <span className="mono">{name}</span>
              <span className="badge">{t(`resources.kind.${resource.kind}`)}</span>
            </span>
            {resource.description && <span className="small muted assistant-resource-desc">{resource.description}</span>}
            {!accepted && (
              <span className="mono small muted assistant-resource-path">
                {t(`resources.scope.${resource.scope}`)} · {resource.path}
              </span>
            )}
          </div>
        )}
      </div>
      {!phone && (
        <div className="suggestion-main">
          <span className="suggestion-title">
            <span className="mono">{name}</span>
            <span className="badge">{t(`resources.kind.${resource.kind}`)}</span>
          </span>
          {accepted
            ? resource.description && <span className="small muted assistant-resource-desc">{resource.description}</span>
            : proposal.reason && <p className="suggestion-reason">{proposal.reason}</p>}
        </div>
      )}
      {phone && !accepted && proposal.reason && <p className="suggestion-reason">{proposal.reason}</p>}
      <Actions proposal={proposal} name={name} decide={decide} done={done} primary={review} phone={phone} />
    </li>
  );
}
