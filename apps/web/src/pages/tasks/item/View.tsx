import type { WorkItemDetail } from '@agentry/shared';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useWorkItemChanges } from '../../../api';
import { Tooltip } from '@agentry/ui/components/controls/Tooltip';
import { ICON } from '@agentry/ui/components/icons';
import { EpicLabel, PriorityMark, WorkItemKey, WorkItemStatusIcon, WorkItemTypeIcon } from '../../../components/work-item-icons';
import { Segmented } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { columnMeta, priorityMeta } from '../../../lib/work-items';
import { Activity, CommentBox, useItemRuns } from './Activity';
import { Changes } from './Changes';
import { Criteria } from './Criteria';
import { DecisionMark } from '../../../components/DecisionMark';
import { Description, Title } from './Description';
import { ItemDocuments } from './Documents';
import {
  AssigneeMark,
  NONE,
  assigneeOf,
  assigneeValue,
  useAssigneeName,
  useAssigneeOptions,
  useEpicOptions,
  useMilestoneOptions,
  usePriorityOptions,
  useStatusOptions,
  useTypeOptions,
} from './fields';
import { useItemActions, useMoveItem, usePersonName, type ItemActions } from './hooks';
import { Links } from './Links';
import { Picker } from './Picker';
import { PullRequestState } from './PullRequest';
import { useRefreshPullRequestOnOpen } from '../board/PullRequest';
import { LabelsEditor, Properties } from './Properties';
import { Relations } from './Relations';
import { WaitingBadge, WaitingState } from './Waiting';
import { CopyLink, ItemMenu, StatusBadge, useBackPath, useItemButtons, type ItemVariant } from './ViewHead';

export type { ItemVariant } from './ViewHead';

// ---------- desktop: the page and the panel ----------

function Wide({ item, actions, person, variant }: { item: WorkItemDetail; actions: ItemActions; person: string; variant: ItemVariant }) {
  const { t } = useTranslation('workItem');
  const buttons = useItemButtons(item, actions);
  const back = useBackPath();
  const head = (
    <div className="workitem-head">
      {variant === 'page' && (
        <Tooltip content={t('actions.back')}>
          <Link to={back} className="icon-btn workitem-back" aria-label={t('actions.back')}>
            <ChevronLeft {...ICON} />
          </Link>
        </Tooltip>
      )}
      <WorkItemTypeIcon type={item.type} large />
      {/* The panel names the key in its own title already */}
      {variant === 'page' && <WorkItemKey value={item.key} boxed />}
      <StatusBadge item={item} />
      <WaitingBadge item={item} />
      <DecisionMark subjectKind="work_item" subjectId={item.id} />
      <span className="grow" />
      <CopyLink item={item} />
      <ItemMenu item={item} variant={variant} withCopy={false} />
      {buttons.done}
      {buttons.work}
    </div>
  );
  const main = (
    <>
      {head}
      {buttons.refusal}
      <WaitingState item={item} actions={actions} />
      <PullRequestState item={item} />
      <div className="workitem-heading">
        <Title item={item} actions={actions} />
        <Description item={item} actions={actions} />
      </div>
      <Criteria item={item} actions={actions} person={person} />
      <Relations
        itemId={item.id}
        projectId={item.projectId}
        relations={item.relations}
        onAdd={(type, other) => actions.relate.mutate({ type, itemId: other.id })}
        onRemove={(otherId) => actions.unrelate.mutate(otherId)}
      />
    </>
  );
  const side = (
    <>
      <Properties item={item} actions={actions} person={person} />
      <Links item={item} />
      <ItemDocuments item={item} />
      <Changes item={item} />
    </>
  );
  if (variant === 'panel') {
    return (
      <div className="workitem-layout is-panel">
        {main}
        <div className="workitem-side">{side}</div>
        <Activity item={item} actions={actions} person={person} />
        {buttons.dialog}
      </div>
    );
  }
  return (
    <div className="workitem-layout">
      <div className="workitem-main">
        {main}
        <Activity item={item} actions={actions} person={person} />
      </div>
      <aside className="workitem-side" aria-label={t('props.label')}>
        {side}
      </aside>
      {buttons.dialog}
    </div>
  );
}

// ---------- phone ----------

type Section = 'detail' | 'activity' | 'changes';

function Narrow({ item, actions, person }: { item: WorkItemDetail; actions: ItemActions; person: string }) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const [section, setSection] = useState<Section>('detail');
  const buttons = useItemButtons(item, actions);
  const move = useMoveItem(item, actions);
  const back = useBackPath();
  const statuses = useStatusOptions();
  const priorities = usePriorityOptions();
  const types = useTypeOptions(undefined, item.type);
  const assignees = useAssigneeOptions(person, item.assignee, item.projectId);
  const epics = useEpicOptions(item.projectId, item.id);
  const milestones = useMilestoneOptions(item.projectId, item.milestoneId);
  const milestone = milestones.milestones.find((m) => m.id === item.milestoneId) ?? null;
  const changes = useWorkItemChanges(item.id);
  const summary = changes.data?.summary;
  const changed = summary ? new Set([...summary.files, ...summary.uncommitted].map((f) => f.path)).size : 0;
  const assigneeName = useAssigneeName(person)(item.assignee);
  const { retries } = useItemRuns(item);

  return (
    <div className="workitem-layout is-phone">
      <header className="workitem-mhead">
        <Link to={back} className="icon-btn workitem-back" aria-label={t('actions.back')}>
          <ChevronLeft {...ICON} />
        </Link>
        <Picker
          label={t('fields.type')}
          value={item.type}
          options={types.map((option) => (option.value === 'epic' && item.epicId ? { ...option, disabled: true, reason: t('fields.epicUnderEpic') } : option))}
          onPick={(type) => actions.update.mutate({ type })}
          trigger={
            <button type="button" className="icon-btn" aria-label={t('fields.typeIs', { type: tt(`type.${item.type}`) })}>
              <WorkItemTypeIcon type={item.type} large decorative />
            </button>
          }
        />
        <WorkItemKey value={item.key} boxed />
        <WaitingBadge item={item} />
        <span className="grow" />
        <ItemMenu item={item} variant="page" withCopy />
      </header>
      <div className="workitem-mbody">
        <Title item={item} actions={actions} />
        <div className="workitem-chips">
          <Picker
            label={t('fields.status')}
            value={item.status}
            options={statuses}
            onPick={move}
            trigger={
              <button type="button" className="chip workitem-chip" aria-label={t('fields.statusIs', { status: tt(columnMeta(item.status).label) })}>
                <WorkItemStatusIcon status={item.status} decorative />
                {tt(columnMeta(item.status).label)}
              </button>
            }
          />
          <Picker
            label={t('fields.priority')}
            value={item.priority}
            options={priorities}
            onPick={(priority) => actions.update.mutate({ priority })}
            trigger={
              <button type="button" className="chip workitem-chip" aria-label={t('fields.priorityIs', { priority: tt(priorityMeta(item.priority).label) })}>
                <PriorityMark priority={item.priority} />
                {tt(priorityMeta(item.priority).label)}
              </button>
            }
          />
          <Picker
            label={t('fields.assignee')}
            value={assigneeValue(item.assignee)}
            options={assignees}
            onPick={(value) => actions.update.mutate({ assignee: assigneeOf(value) })}
            trigger={
              <button type="button" className="chip workitem-chip" aria-label={t('fields.assigneeIs', { assignee: assigneeName })}>
                <AssigneeMark assignee={item.assignee} person={person} />
                {assigneeName}
              </button>
            }
          />
        </div>
        <div className="workitem-facts">
          {item.type !== 'epic' && (
            <Picker
              label={t('fields.epic')}
              value={item.epicId ?? NONE}
              options={epics.options}
              onPick={(value) => actions.update.mutate({ epicId: value === NONE ? null : value })}
              trigger={
                <button type="button" className="workitem-fact" aria-label={t('fields.epicIs', { epic: item.epic?.title ?? t('fields.noEpic') })}>
                  {item.epic ? <EpicLabel epic={item.epic} /> : <span className="muted">{t('fields.noEpic')}</span>}
                </button>
              }
            />
          )}
          <Picker
            label={t('fields.milestone')}
            value={item.milestoneId ?? NONE}
            options={milestones.options}
            onPick={(value) => actions.update.mutate({ milestoneId: value === NONE ? null : value })}
            trigger={
              <button type="button" className="workitem-fact" aria-label={t('fields.milestoneIs', { milestone: milestone?.name ?? t('fields.noMilestone') })}>
                {milestone ? <span className="milestone-name">{milestone.name}</span> : <span className="muted">{t('fields.noMilestone')}</span>}
              </button>
            }
          />
          <LabelsEditor labels={item.labels} onChange={(labels) => actions.update.mutate({ labels })} />
        </div>
        <Segmented<Section>
          label={t('sections.label')}
          value={section}
          onChange={setSection}
          options={[
            { value: 'detail', label: t('sections.detail') },
            {
              value: 'activity',
              label: (
                <>
                  {t('sections.activity')} <span className="segment-count">{item.history.length + retries.length + item.comments.length}</span>
                </>
              ),
            },
            {
              value: 'changes',
              label: (
                <>
                  {t('sections.changes')} <span className="segment-count">{changed}</span>
                </>
              ),
            },
          ]}
        />
        {section === 'detail' && (
          <>
            {buttons.refusal}
            <WaitingState item={item} actions={actions} />
            <PullRequestState item={item} />
            <Description item={item} actions={actions} />
            <Criteria item={item} actions={actions} person={person} compact />
            <Relations
              itemId={item.id}
              projectId={item.projectId}
              relations={item.relations}
              onAdd={(type, other) => actions.relate.mutate({ type, itemId: other.id })}
              onRemove={(otherId) => actions.unrelate.mutate(otherId)}
              compact
            />
            <Links item={item} />
            <ItemDocuments item={item} />
          </>
        )}
        {section === 'activity' && <Activity item={item} actions={actions} person={person} compact />}
        {section === 'changes' && <Changes item={item} compact />}
      </div>
      <div className="workitem-mfoot">
        {section === 'activity' ? (
          <CommentBox actions={actions} compact />
        ) : (
          <>
            {buttons.done}
            {buttons.work}
          </>
        )}
      </div>
      {buttons.dialog}
    </div>
  );
}

/**
 * A work item, whole: key and title, its fields edited in place, the description, the acceptance
 * checklist, relations, the chats and orchestrations that worked on it, what changed in its
 * worktree, and its activity. The page at `/tasks/:key` and the board's panel both draw this.
 */
export function WorkItemView({ item, variant }: { item: WorkItemDetail; variant: ItemVariant }) {
  const narrow = useMediaQuery(NARROW);
  const actions = useItemActions(item.id);
  const person = usePersonName();
  useRefreshPullRequestOnOpen(item);
  if (narrow) return <Narrow item={item} actions={actions} person={person} />;
  return <Wide item={item} actions={actions} person={person} variant={variant} />;
}
