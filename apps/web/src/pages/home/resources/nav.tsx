import type { AssistantResourceKind, AssistantResourceProposal, ResourceKind } from '@agentry/shared';
import { ChevronDown, Sparkle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Menu } from '@agentry/ui/components/controls/Menu';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Segmented, Tag } from '@agentry/ui/components/ui';
import { AI_KINDS, isAiKind, OTHER_KINDS, type ResourceSection } from './model';

/** "All" and the kinds the assistant handles, each with how many the project has. */
export function SectionControl({ section, count, onChange }: { section: 'all' | AssistantResourceKind; count: (kind: AssistantResourceKind) => number; onChange: (next: 'all' | AssistantResourceKind) => void }) {
  const { t } = useTranslation(['config', 'projects']);
  const kindLabel = (kind: ResourceKind, n?: number) => (
    <span className="resources-seg-option">
      {t(`config.tabs.${kind}`)}
      {n !== undefined && <span className="count">{n}</span>}
    </span>
  );
  return (
    <div className="resources-sections">
      <Segmented<'all' | AssistantResourceKind>
        label={t('projects:resources.sections')}
        value={section}
        onChange={onChange}
        options={[
          {
            value: 'all',
            label: (
              <span className="resources-seg-option">
                {t('resourcesAi.all')}
                <span className="count">{AI_KINDS.reduce((sum, kind) => sum + count(kind), 0)}</span>
              </span>
            ),
          },
          ...AI_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind, count(kind)) })),
        ]}
      />
    </div>
  );
}

/** The kinds the assistant does not handle. A phone has no room beside the kinds, so they are a "⋯" beside "New". */
export function OtherKindsMenu({ section, phone, onSelect }: { section: ResourceSection; phone: boolean; onSelect: (kind: ResourceKind) => void }) {
  const { t } = useTranslation(['config', 'projects']);
  const otherOn = !isAiKind(section) && section !== 'all';
  return (
    <Menu
      label={t('resourcesAi.otherKinds')}
      align={phone ? 'end' : 'start'}
      entries={OTHER_KINDS.map((kind) => ({ id: kind, label: t(`config.tabs.${kind}`), onSelect: () => onSelect(kind) }))}
      {...(phone
        ? {}
        : {
            trigger: (
              <button type="button" className={`btn btn-quiet resources-other ${otherOn ? 'is-on' : ''}`.trim()}>
                {otherOn ? t(`config.tabs.${section}`) : t('resourcesAi.otherKinds')}
                <ChevronDown {...ICON_SM} />
              </button>
            ),
          })}
    />
  );
}

/** The pending proposals above the project's resources while the editor is open. */
export function PendingProposalNav({ proposals, current, onOpen }: { proposals: AssistantResourceProposal[]; current: string | null; onOpen: (proposal: AssistantResourceProposal) => void }) {
  const { t } = useTranslation(['config', 'projects']);
  return (
    <div className="resources-group">
      <div className="resources-group-head">
        <Sparkle {...ICON_SM} />
        <span className="section-label grow">{t('resourcesAi.proposalsShort')}</span>
        <span className="mono small muted">{proposals.length}</span>
      </div>
      <ul className="master-list" aria-label={t('resourcesAi.proposalsShort')}>
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <button
              type="button"
              aria-current={proposal.id === current ? 'true' : undefined}
              className={`master-item resource-item ${proposal.id === current ? 'master-item-on' : ''}`.trim()}
              onClick={() => onOpen(proposal)}
            >
              <span className="master-item-head">
                <span className="mono resource-item-name">{proposal.resource.kind === 'commands' ? `/${proposal.resource.name}` : proposal.resource.name}</span>
                <span className="mono small muted">{t(`resourcesAi.kindLower.${proposal.resource.kind}`)}</span>
              </span>
              <span className="small muted resource-item-desc">{proposal.resource.description || proposal.reason}</span>
              {proposal.id === current && (
                <span className="resource-item-badge">
                  <Tag tone="warn">{t('resources.notSavedYet')}</Tag>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
