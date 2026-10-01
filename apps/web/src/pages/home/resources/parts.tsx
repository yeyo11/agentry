import type { AssistantResourceKind, AssistantResourceProposal, AssistantRun, ConfigResource, ResourceKind } from '@agentry/shared';
import { Check, ChevronDown, ChevronRight, Pencil, SquareSlash, Terminal, Undo2, Users, X, Zap, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AssistantMark, LiveRunHead, RunFacts, RunSources } from '../../../components/assistant/run';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Skeleton, Tag } from '@agentry/ui/components/ui';
import { timeAgo } from '@agentry/ui/lib/format';
import { savePath, shownName } from './model';

const KIND_ICON: Record<AssistantResourceKind, LucideIcon> = { agents: Terminal, skills: Zap, commands: SquareSlash };

export function KindIcon({ kind }: { kind: AssistantResourceKind }) {
  const Icon = KIND_ICON[kind];
  return <Icon {...ICON_SM} />;
}

/** The kind as a neutral badge beside a proposal's name ("AGENT"), and its icon on a tile before it. */
function KindTile({ kind }: { kind: AssistantResourceKind }) {
  const { t } = useTranslation('config');
  return (
    <span className="link-ico resource-kind-tile" role="img" aria-label={t(`resourcesAi.kind.${kind}`)}>
      <KindIcon kind={kind} />
    </span>
  );
}

/**
 * One resource proposal (`.suggestion-row`): its name, what it does, where it would be saved and
 * why. Pending: "Discard" and "Review", which opens it in the editor, where saving it is accepting
 * it. Saved: where it went. Discarded: struck through, with "Undo". On a phone the whole row opens it.
 */
export function ResourceProposalRow({
  proposal,
  phone,
  onReview,
  onDecide,
  deciding,
}: {
  proposal: AssistantResourceProposal;
  phone: boolean;
  onReview: () => void;
  onDecide: (action: 'discard' | 'restore') => void;
  deciding: boolean;
}) {
  const { t } = useTranslation('config');
  const { resource } = proposal;
  const name = shownName(resource.kind, resource.name);
  const state = proposal.status === 'accepted' ? 'is-accepted' : proposal.status === 'discarded' ? 'is-discarded' : '';
  const where = proposal.saved ?? { scope: resource.scope, path: savePath(resource.kind, resource.name, resource.scope) };

  const main = (
    <div className="suggestion-main">
      <span className="suggestion-title">
        <span className="mono">{name}</span>
        <Tag>{t(`resourcesAi.kind.${resource.kind}`)}</Tag>
      </span>
      {proposal.status !== 'discarded' && !phone && resource.description && <span className="resource-proposal-desc">{resource.description}</span>}
      {proposal.status !== 'discarded' && !phone && (
        <div className="suggestion-meta">
          <span>{t(`resourcesAi.scope.${where.scope}`)}</span>
          <span aria-hidden>·</span>
          <span className="mono">{where.path}</span>
        </div>
      )}
      {proposal.status === 'pending' && (proposal.reason || (phone && resource.description)) && (
        <p className={phone ? 'resource-proposal-desc' : 'suggestion-reason'}>{proposal.reason || resource.description}</p>
      )}
    </div>
  );

  const decided =
    proposal.status === 'accepted' ? (
      <span className="suggestion-done">
        <Check {...ICON_SM} />
        {t('resourcesAi.saved')}
      </span>
    ) : proposal.status === 'discarded' ? (
      <button type="button" className="btn btn-quiet btn-small" disabled={deciding} onClick={() => onDecide('restore')}>
        <Undo2 {...ICON_SM} />
        {t('resourcesAi.undo')}
      </button>
    ) : null;

  if (phone && proposal.status === 'pending')
    return (
      <button type="button" className="suggestion-row resource-proposal is-button" onClick={onReview}>
        <KindTile kind={resource.kind} />
        {main}
        <ChevronRight {...ICON_SM} className="resource-proposal-chevron" />
      </button>
    );

  return (
    <div className={`suggestion-row resource-proposal ${state}`.trim()}>
      <KindTile kind={resource.kind} />
      {main}
      <div className="suggestion-acts">
        {proposal.status === 'pending' ? (
          <>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              aria-label={t('resourcesAi.discardName', { name })}
              disabled={deciding}
              onClick={() => onDecide('discard')}
            >
              <X {...ICON_SM} />
              {t('resourcesAi.discard')}
            </button>
            <button type="button" className="btn btn-small" aria-label={t('resourcesAi.reviewName', { name })} onClick={onReview}>
              <Pencil {...ICON_SM} />
              {t('resourcesAi.review')}
            </button>
          </>
        ) : (
          decided
        )}
      </div>
    </div>
  );
}

/**
 * "Proposals of the assistant": the card of what "Suggest" (and "Create with AI") left to review,
 * the tab's one gradient surface. While "Suggest" reads the project the card is the live run
 * instead, with the screen's energy border.
 */
export function ProposalsCard({
  run,
  proposals,
  loading,
  phone,
  onReview,
  onDecide,
  onDiscardAll,
  onStop,
  deciding,
}: {
  /** The latest "Suggest"; null when only "Create with AI" left proposals */
  run: AssistantRun | null;
  proposals: AssistantResourceProposal[];
  loading: boolean;
  phone: boolean;
  onReview: (proposal: AssistantResourceProposal) => void;
  onDecide: (proposal: AssistantResourceProposal, action: 'discard' | 'restore') => void;
  onDiscardAll: () => void;
  onStop: () => void;
  deciding: string | null;
}) {
  const { t } = useTranslation('config');
  if (run?.status === 'running')
    return (
      <section className="suggestion-run is-live live-energy resources-run" aria-label={t('resourcesAi.reading')}>
        <LiveRunHead run={run} title={t('resourcesAi.reading')} onStop={onStop} />
        <RunFacts run={run} />
        <RunSources sources={run.sources} />
      </section>
    );

  const pending = proposals.filter((p) => p.status === 'pending').length;
  const failed = run && (run.status === 'failed' || run.status === 'stopped') && proposals.length === 0;
  return (
    <section className="card grad-border resources-proposals" aria-label={t('resourcesAi.proposals')}>
      <div className="resources-proposals-head">
        <AssistantMark small />
        <div className="resources-proposals-title">
          <h2>{t('resourcesAi.proposals')}</h2>
          {phone && run && <RunFacts run={run} label={t('resourcesAi.toReview', { count: pending })} ago />}
          {!phone && <span className="mono small muted">{t('resourcesAi.toReview', { count: pending })}</span>}
        </div>
        {!phone && pending > 1 && (
          <button type="button" className="btn btn-quiet btn-small" onClick={onDiscardAll}>
            {t('resourcesAi.discardAll')}
          </button>
        )}
      </div>
      {!phone && run && (
        <div className="resources-proposals-facts">
          <RunFacts run={run} label={t('resourcesAi.suggest')} ago />
        </div>
      )}
      {loading ? (
        <div className="resources-proposals-loading">
          <Skeleton rows={3} height={16} />
        </div>
      ) : failed ? (
        <p className="resources-proposals-note">{run.status === 'stopped' ? t('resourcesAi.stopped') : t('resourcesAi.failed')}</p>
      ) : proposals.length === 0 ? (
        <p className="resources-proposals-note">{t('resourcesAi.nothing')}</p>
      ) : (
        proposals.map((proposal) => (
          <ResourceProposalRow
            key={proposal.id}
            proposal={proposal}
            phone={phone}
            onReview={() => onReview(proposal)}
            onDecide={(action) => onDecide(proposal, action)}
            deciding={deciding === proposal.id}
          />
        ))
      )}
      {!phone && <p className="form-hint resources-proposals-hint">{t('resourcesAi.hint')}</p>}
    </section>
  );
}

/** How many of a kind a group shows before "N more". */
const FOLDED = 2;

/**
 * "In the project": the project's agents, skills and commands, by kind, each group folded after two.
 * The same list is the master of the editor, with the proposals above it.
 */
export function InProjectList({
  kinds,
  resources,
  loading,
  current,
  teamMembers,
  teamTo,
  onOpen,
  children,
}: {
  kinds: AssistantResourceKind[];
  resources: Partial<Record<AssistantResourceKind, ConfigResource[]>>;
  loading: boolean;
  /** The resource open in the editor, as `kind:name` */
  current: string | null;
  /** Members of the Team module: they are agents too, but live in Team */
  teamMembers: number;
  teamTo: string;
  onOpen: (kind: AssistantResourceKind, name: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation('config');
  const [open, setOpen] = useState<Set<ResourceKind>>(new Set());
  return (
    <div className="resources-groups">
      {children}
      {kinds.map((kind) => {
        const list = resources[kind] ?? [];
        // A group folded around the open file still shows it
        const unfolded = open.has(kind) || kinds.length === 1;
        const shown = unfolded ? list : list.filter((r, i) => i < FOLDED || `${kind}:${r.name}` === current);
        const more = list.length - shown.length;
        return (
          <div key={kind} className="resources-group">
            <div className="resources-group-head">
              <KindIcon kind={kind} />
              <span className="section-label grow">{t(`config.tabs.${kind}`)}</span>
              <span className="mono small muted">{list.length}</span>
            </div>
            {loading && list.length === 0 ? (
              <Skeleton rows={2} height={14} />
            ) : list.length === 0 ? (
              <p className="resources-group-empty">{t(`resources.kinds.${kind}.noneInScope`)}</p>
            ) : (
              <ul className="master-list" aria-label={t(`config.tabs.${kind}`)}>
                {shown.map((resource) => {
                  const on = current === `${kind}:${resource.name}`;
                  return (
                    <li key={resource.name}>
                      <button
                        type="button"
                        aria-current={on ? 'true' : undefined}
                        className={`master-item resource-item ${on ? 'master-item-on' : ''}`.trim()}
                        onClick={() => onOpen(kind, resource.name)}
                      >
                        <span className="master-item-head">
                          <span className="mono resource-item-name">{shownName(kind, resource.name)}</span>
                          {resource.updatedAt && <span className="mono small muted">{timeAgo(resource.updatedAt)}</span>}
                        </span>
                        <span className="small muted resource-item-desc">{resource.description ?? t('resources.noDescription')}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {more > 0 && (
              <button type="button" className="resources-more" onClick={() => setOpen((now) => new Set(now).add(kind))}>
                <ChevronDown {...ICON_SM} />
                {t('resourcesAi.more', { count: more })}
              </button>
            )}
            {kind === 'agents' && teamMembers > 0 && (
              <Link to={teamTo} className="resources-team-note">
                <Users {...ICON_SM} />
                {t('resourcesAi.teamNote', { count: teamMembers })}
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
