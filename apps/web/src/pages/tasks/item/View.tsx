import type { WorkItemDetail } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, CircleAlert, ExternalLink, Link2, MessageSquare, Play, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useWorkItemChanges } from '../../../api';
import { MoreActions } from '../../../components/controls';
import { Tooltip } from '../../../components/controls/Tooltip';
import { useConfirm } from '../../../components/Dialog';
import { EpicLabel, ICON, ICON_SM, PriorityMark, WorkItemKey, WorkItemStatusIcon, WorkItemTypeIcon } from '../../../components/icons';
import { useToast } from '../../../components/Toast';
import { Segmented } from '../../../components/ui';
import { NARROW, useMediaQuery } from '../../../lib/media';
import { TASKS_PATH, columnMeta, priorityMeta, taskPath } from '../../../lib/work-items';
import { Activity, CommentBox } from './Activity';
import { Changes } from './Changes';
import { Criteria } from './Criteria';
import { Description, Title } from './Description';
import {
  AssigneeMark,
  NONE,
  assigneeOf,
  assigneeValue,
  useAssigneeOptions,
  useEpicOptions,
  useMilestoneOptions,
  usePriorityOptions,
  useStatusOptions,
  useTypeOptions,
} from './fields';
import { useItemActions, usePersonName, type ItemActions } from './hooks';
import { Links } from './Links';
import { workOnBlocker } from './model';
import { Picker } from './Picker';
import { LabelsEditor, Properties } from './Properties';
import { Relations } from './Relations';
import { WorkOnDialog } from './WorkOn';

/** Where a work item is shown: its own page, or the panel the board opens beside itself. */
export type ItemVariant = 'page' | 'panel';

/** The item's column as a badge with its glyph and word; only Done is coloured, and it is named. */
function StatusBadge({ item }: { item: Pick<WorkItemDetail, 'status'> }) {
  const { t } = useTranslation('tasks');
  return (
    <span className={`badge workitem-status-badge ${item.status === 'done' ? 'badge-ok' : ''}`.trim()}>
      <WorkItemStatusIcon status={item.status} decorative />
      {t(columnMeta(item.status).label)}
    </span>
  );
}

/**
 * The item's two actions: "Work on it", the primary, which starts a chat through the API, and "Move
 * to Done", the person's approval (decision 29). Where "Work on it" cannot start, it says why in
 * words instead of failing on press: an epic is not worked on, Done is final, and an item a chat is
 * already on offers that chat.
 */
function useItemButtons(item: WorkItemDetail, actions: ItemActions) {
  const { t } = useTranslation('workItem');
  const [starting, setStarting] = useState(false);
  const blocker = workOnBlocker(item);
  const activeChat = item.activeLink?.chatId;
  const done =
    item.status === 'done' ? null : (
      <button type="button" className="btn workitem-done" onClick={() => actions.move.mutate('done')} disabled={actions.move.isPending}>
        <Check {...ICON_SM} />
        {t('actions.moveToDone')}
      </button>
    );
  let work: ReactNode = null;
  if (blocker === 'busy' && activeChat) {
    work = (
      <Link to={`/chats/${activeChat}`} className="btn workitem-work">
        <MessageSquare {...ICON_SM} />
        {t('actions.openChat')}
      </Link>
    );
  } else if (blocker === null) {
    work = (
      <button type="button" className="btn btn-primary workitem-work" onClick={() => setStarting(true)}>
        <Play {...ICON_SM} />
        {t('actions.workOn')}
      </button>
    );
  }
  const refusal =
    blocker === 'epic' || blocker === 'done' ? (
      <p className="workitem-refusal" role="note">
        <CircleAlert {...ICON_SM} />
        {t(`workOn.blocked.${blocker}`)}
      </p>
    ) : null;
  const dialog = starting ? <WorkOnDialog item={item} onClose={() => setStarting(false)} /> : null;
  return { done, work, refusal, dialog };
}

/** The `⋯` of the item: copy its link, open it as a page from the panel, delete it after a confirmation. */
function ItemMenu({ item, variant, withCopy }: { item: WorkItemDetail; variant: ItemVariant; withCopy: boolean }) {
  const { t } = useTranslation('workItem');
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteWorkItem(item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.workItems });
      navigate(TASKS_PATH);
    },
    onError: (error) => toast.error(t('errors.delete'), error),
  });
  const copy = () => void navigator.clipboard?.writeText(`${location.origin}${taskPath(item.key)}`).then(() => toast.success(t('actions.copied')));
  return (
    <MoreActions
      label={t('actions.more')}
      entries={[
        ...(withCopy ? [{ id: 'copy', label: t('actions.copyLink'), icon: Link2, onSelect: copy }] : []),
        ...(variant === 'panel' ? [{ id: 'page', label: t('actions.openPage'), icon: ExternalLink, onSelect: () => navigate(taskPath(item.key)) }] : []),
        {
          id: 'delete',
          label: t('actions.delete'),
          icon: Trash2,
          destructive: true,
          onSelect: () =>
            void confirm({ title: t('delete.title', { key: item.key }), body: t('delete.body'), confirmLabel: t('actions.delete'), danger: true }).then(
              (ok) => ok && remove.mutate(),
            ),
        },
      ]}
    />
  );
}

function CopyLink({ item }: { item: WorkItemDetail }) {
  const { t } = useTranslation('workItem');
  const toast = useToast();
  return (
    <Tooltip content={t('actions.copyLink')}>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('actions.copyLink')}
        onClick={() => void navigator.clipboard?.writeText(`${location.origin}${taskPath(item.key)}`).then(() => toast.success(t('actions.copied')))}
      >
        <Link2 {...ICON_SM} />
      </button>
    </Tooltip>
  );
}

// ---------- desktop: the page and the panel ----------

function Wide({ item, actions, person, variant }: { item: WorkItemDetail; actions: ItemActions; person: string; variant: ItemVariant }) {
  const { t } = useTranslation('workItem');
  const buttons = useItemButtons(item, actions);
  const head = (
    <div className="workitem-head">
      {variant === 'page' && (
        <Tooltip content={t('actions.back')}>
          <Link to={TASKS_PATH} className="icon-btn workitem-back" aria-label={t('actions.back')}>
            <ChevronLeft {...ICON} />
          </Link>
        </Tooltip>
      )}
      <WorkItemTypeIcon type={item.type} large />
      {/* The panel names the key in its own title already */}
      {variant === 'page' && <WorkItemKey value={item.key} boxed />}
      <StatusBadge item={item} />
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
  const statuses = useStatusOptions();
  const priorities = usePriorityOptions();
  const types = useTypeOptions(undefined, item.type);
  const assignees = useAssigneeOptions(person, item.assignee);
  const epics = useEpicOptions(item.projectId, item.id);
  const milestones = useMilestoneOptions(item.projectId, item.milestoneId);
  const milestone = milestones.milestones.find((m) => m.id === item.milestoneId) ?? null;
  const changes = useWorkItemChanges(item.id);
  const summary = changes.data?.summary;
  const changed = summary ? new Set([...summary.files, ...summary.uncommitted].map((f) => f.path)).size : 0;
  const assigneeName = item.assignee ? (item.assignee.kind === 'person' ? person : item.assignee.role) : t('fields.noAssignee');

  return (
    <div className="workitem-layout is-phone">
      <header className="workitem-mhead">
        <Link to={TASKS_PATH} className="icon-btn workitem-back" aria-label={t('actions.back')}>
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
            onPick={(status) => actions.move.mutate(status)}
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
                  {t('sections.activity')} <span className="segment-count">{item.history.length + item.comments.length}</span>
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
  if (narrow) return <Narrow item={item} actions={actions} person={person} />;
  return <Wide item={item} actions={actions} person={person} variant={variant} />;
}
