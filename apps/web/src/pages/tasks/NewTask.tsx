import type { WorkItem, WorkItemAssignee, WorkItemPriority, WorkItemRef, WorkItemRelationType, WorkItemStatus, WorkItemType } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ComponentPropsWithRef, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys, useProjectSettings, useProjects } from '../../api';
import { Checkbox, Select } from '../../components/controls';
import { hasOpenLayer } from '../../components/controls/layer';
import { Dialog } from '../../components/Dialog';
import { ICON_SM, PriorityMark, WorkItemKey, WorkItemStatusIcon, WorkItemTypeIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, Segmented } from '../../components/ui';
import { NARROW, useMediaQuery } from '../../lib/media';
import { columnMeta, priorityMeta, taskPath, WORK_ITEM_TYPE_META } from '../../lib/work-items';
import {
  AssigneeMark,
  EpicDot,
  NONE,
  assigneeOf,
  assigneeValue,
  useAssigneeName,
  useAssigneeOptions,
  useEpicOptions,
  useMilestoneOptions,
  usePriorityOptions,
  useStatusOptions,
} from './item/fields';
import { usePersonName } from './item/hooks';
import { addLabel, cleanCriteria } from './item/model';
import { Picker } from './item/Picker';
import { LabelsEditor } from './item/Properties';
import { RelationDialog, RelationRow } from './item/Relations';

export interface NewTaskProps {
  /** The project the task goes into; with All projects, the form asks for one */
  projectId: string | null;
  /** The column it starts in: the "+" of a column passes its own. Default Backlog */
  status?: WorkItemStatus;
  onClose: () => void;
  onCreated?: (item: WorkItem) => void;
}

interface Draft {
  type: WorkItemType;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  assignee: WorkItemAssignee | null;
  epicId: string | null;
  milestoneId: string | null;
  labels: string[];
  relations: Array<{ type: WorkItemRelationType; item: WorkItemRef }>;
  criteria: string[];
}

const blank = (status: WorkItemStatus, type: WorkItemType): Draft => ({
  type,
  title: '',
  description: '',
  status,
  priority: 'medium',
  assignee: null,
  epicId: null,
  milestoneId: null,
  labels: [],
  relations: [],
  criteria: [],
});

/** A field's trigger in the dialog: the app's select look, with the value drawn as the board draws it. */
function FieldButton({ label, children, ...rest }: { label: string; children: ReactNode } & Omit<ComponentPropsWithRef<'button'>, 'children'>) {
  return (
    <button type="button" {...rest} className="select-trigger newtask-select">
      <span className="sr-only">{label}: </span>
      <span className="select-value newtask-select-value">{children}</span>
      <ChevronDown {...ICON_SM} className="select-chevron" />
    </button>
  );
}

/** A phone cell: its name, its value, and the chevron of a cell that opens a choice. */
function Cell({ label, children, ...rest }: { label: string; children: ReactNode } & Omit<ComponentPropsWithRef<'button'>, 'children'>) {
  return (
    <button type="button" {...rest} className="newtask-cell">
      <span className="newtask-cell-key">{label}</span>
      <span className="newtask-cell-value">{children}</span>
      <ChevronRight {...ICON_SM} className="newtask-cell-chevron" />
    </button>
  );
}

/**
 * The phone's full screen: "Cancel · New task · key" on top, the form, and "Create task" at the
 * bottom. Escape closes it and focus returns where it was, as a dialog does.
 */
function FullScreen({ title, aside, onClose, children, footer }: { title: string; aside: ReactNode; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const { t } = useTranslation('workItem');
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !hasOpenLayer()) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div ref={panel} className="newtask-screen" role="dialog" aria-modal="true" aria-labelledby={id}>
      {/* A div, not a header: outside a sectioning element a header is the page's banner, and the
          shell's top bar already is that */}
      <div className="newtask-screen-head">
        <button type="button" className="btn newtask-cancel" onClick={onClose}>
          {t('actions.cancel')}
        </button>
        <h2 id={id}>{title}</h2>
        <span className="newtask-screen-aside">{aside}</span>
      </div>
      <div className="newtask-screen-body">{children}</div>
      <div className="newtask-screen-foot">{footer}</div>
    </div>,
    document.body,
  );
}

/**
 * The New task form: a dialog on a desktop, a full screen on a phone, with type, title,
 * description, column, priority, assignee, epic, milestone, labels, relations and acceptance
 * criteria. The board opens it from its "New task", a column's "+" and `?new=1`.
 */
export function NewTask({ projectId, status = 'backlog', onClose, onCreated }: NewTaskProps) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const narrow = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const person = usePersonName();
  const projects = useProjects(false);
  const boards = (projects.data ?? []).filter((p) => p.modules.includes('board'));
  const [chosen, setChosen] = useState<string>(projectId ?? '');
  const project = boards.find((p) => p.id === (projectId ?? chosen)) ?? null;
  const settings = useProjectSettings(project?.id ?? null);
  const offered = settings.data?.board.types.length ? settings.data.board.types : WORK_ITEM_TYPE_META.map((m) => m.type);
  const firstType: WorkItemType = offered.includes('task') ? 'task' : (offered[0] ?? 'task');
  const [draft, setDraft] = useState<Draft>(() => blank(status, firstType));
  const [another, setAnother] = useState(false);
  const [relating, setRelating] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const title = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  // A project whose board offers fewer types starts on one it offers
  useEffect(() => {
    if (!offered.includes(draft.type)) set('type', firstType);
  }, [offered.join(','), firstType]);

  const statuses = useStatusOptions();
  const priorities = usePriorityOptions();
  const assignees = useAssigneeOptions(person, draft.assignee, project?.id ?? null);
  const epics = useEpicOptions(project?.id ?? null);
  const milestones = useMilestoneOptions(project?.id ?? null, draft.milestoneId);
  const epic = epics.epics.find((e) => e.id === draft.epicId) ?? null;
  const milestone = milestones.milestones.find((m) => m.id === draft.milestoneId) ?? null;
  const assigneeName = useAssigneeName(person)(draft.assignee);

  const create = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error(t('newTask.pickProject'));
      const pending = labelDraft.trim() ? addLabel(draft.labels, labelDraft) : draft.labels;
      const item = await api.createWorkItem(project.id, {
        title: draft.title.trim(),
        type: draft.type,
        description: draft.description,
        status: draft.status,
        priority: draft.priority,
        labels: pending,
        assignee: draft.assignee,
        epicId: draft.type === 'epic' ? null : draft.epicId,
        milestoneId: draft.milestoneId,
        acceptanceCriteria: cleanCriteria(draft.criteria),
      });
      // Relations need the item to exist; one refused (a cycle) leaves the task created and says so
      for (const relation of draft.relations) {
        try {
          await api.addWorkItemRelation(item.id, { type: relation.type, itemId: relation.item.id });
        } catch (error) {
          toast.error(t('errors.relate'), error);
        }
      }
      return item;
    },
    onSuccess: (item) => {
      void qc.invalidateQueries({ queryKey: keys.workItems });
      toast.show({ tone: 'ok', title: t('newTask.created', { key: item.key }), action: { label: t('newTask.open'), onClick: () => navigate(taskPath(item.key)) } });
      onCreated?.(item);
      if (another && !narrow) {
        // The next task keeps where it goes (column, epic, milestone, labels) and starts its own text
        setDraft((d) => ({ ...d, title: '', description: '', relations: [], criteria: [] }));
        setLabelDraft('');
        title.current?.focus();
      } else onClose();
    },
  });

  const ready = Boolean(project) && draft.title.trim().length > 0 && !create.isPending;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (ready) create.mutate();
  };

  const typeControl = (
    <Segmented<WorkItemType>
      label={t('fields.type')}
      value={draft.type}
      onChange={(type) => set('type', type)}
      options={WORK_ITEM_TYPE_META.filter((m) => offered.includes(m.type)).map((m) => ({
        value: m.type,
        label: (
          <span className="workitem-option">
            <WorkItemTypeIcon type={m.type} decorative />
            {tt(m.label)}
          </span>
        ),
      }))}
    />
  );
  const projectControl =
    projectId === null ? (
      <div className="form-row">
        <span className="section-label">{t('newTask.project')}</span>
        <Select
          aria-label={t('newTask.project')}
          value={chosen}
          onChange={setChosen}
          placeholder={t('newTask.pickProject')}
          options={boards.map((p) => ({ value: p.id, label: p.name, hint: p.key }))}
        />
      </div>
    ) : null;
  const titleField = (
    <input
      ref={title}
      className="newtask-title"
      data-autofocus
      value={draft.title}
      maxLength={300}
      aria-label={t('fields.title')}
      placeholder={t('newTask.titlePlaceholder')}
      onChange={(e) => set('title', e.target.value)}
    />
  );
  const descriptionField = (
    <textarea
      className="newtask-description"
      rows={3}
      value={draft.description}
      aria-label={t('fields.description')}
      placeholder={t('newTask.descriptionPlaceholder')}
      onChange={(e) => set('description', e.target.value)}
    />
  );
  const relationRows = draft.relations.map((relation, index) => (
    <RelationRow
      key={relation.item.id}
      relation={relation}
      linked={false}
      onRemove={() =>
        set(
          'relations',
          draft.relations.filter((_, i) => i !== index),
        )
      }
    />
  ));
  const relationDialog =
    relating && project ? (
      <RelationDialog
        projectId={project.id}
        exclude={new Set(draft.relations.map((r) => r.item.id))}
        onClose={() => setRelating(false)}
        onPick={(type, item) => {
          setRelating(false);
          set('relations', [...draft.relations, { type, item }]);
        }}
      />
    ) : null;
  const criterionInput = (value: string, index: number, extra?: string) => (
    <input
      className={extra}
      value={value}
      autoFocus={index === draft.criteria.length - 1 && value === ''}
      aria-label={t('criteria.nth', { n: index + 1 })}
      onChange={(e) =>
        set(
          'criteria',
          draft.criteria.map((c, i) => (i === index ? e.target.value : c)),
        )
      }
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          set('criteria', [...draft.criteria, '']);
        }
      }}
    />
  );
  const removeCriterion = (index: number) => (
    <button
      type="button"
      className="icon-btn"
      aria-label={t('criteria.removeNth', { n: index + 1 })}
      onClick={() =>
        set(
          'criteria',
          draft.criteria.filter((_, i) => i !== index),
        )
      }
    >
      <X {...ICON_SM} />
    </button>
  );
  const addCriterion = () => set('criteria', [...draft.criteria, '']);
  const heading = project ? t('newTask.into', { project: project.name, prefix: project.key }) : null;
  const createLabel = create.isPending ? t('newTask.creating') : t('newTask.create');

  // The same pickers in both forms; only their trigger differs
  const pickers = (trigger: (label: string, value: ReactNode) => ReactElement) => ({
    status: (
      <Picker
        label={t('newTask.column')}
        value={draft.status}
        options={statuses}
        onPick={(v) => set('status', v)}
        trigger={trigger(
          t('newTask.column'),
          <>
            <WorkItemStatusIcon status={draft.status} decorative />
            {tt(columnMeta(draft.status).label)}
          </>,
        )}
      />
    ),
    priority: (
      <Picker
        label={t('fields.priority')}
        value={draft.priority}
        options={priorities}
        onPick={(v) => set('priority', v)}
        trigger={trigger(
          t('fields.priority'),
          <>
            <PriorityMark priority={draft.priority} />
            {tt(priorityMeta(draft.priority).label)}
          </>,
        )}
      />
    ),
    assignee: (
      <Picker
        label={t('fields.assignee')}
        value={assigneeValue(draft.assignee)}
        options={assignees}
        onPick={(v) => set('assignee', assigneeOf(v))}
        trigger={trigger(
          t('fields.assignee'),
          <>
            <AssigneeMark assignee={draft.assignee} person={person} />
            <span className={draft.assignee ? '' : 'muted'}>{assigneeName}</span>
          </>,
        )}
      />
    ),
    epic:
      draft.type === 'epic' ? null : (
        <Picker
          label={t('fields.epic')}
          value={draft.epicId ?? NONE}
          options={epics.options}
          onPick={(v) => set('epicId', v === NONE ? null : v)}
          trigger={trigger(
            t('fields.epic'),
            epic ? (
              <>
                <EpicDot epic={epic} />
                {epic.title}
              </>
            ) : (
              <span className="muted">{t('fields.noEpic')}</span>
            ),
          )}
        />
      ),
    milestone: (
      <Picker
        label={t('fields.milestone')}
        value={draft.milestoneId ?? NONE}
        options={milestones.options}
        onPick={(v) => set('milestoneId', v === NONE ? null : v)}
        trigger={trigger(t('fields.milestone'), milestone ? <span className="milestone-name">{milestone.name}</span> : <span className="muted">{t('fields.noMilestone')}</span>)}
      />
    ),
  });

  if (narrow) {
    const cells = pickers((label, value) => <Cell label={label}>{value}</Cell>);
    return (
      <FullScreen
        title={t('newTask.title')}
        aside={project ? <WorkItemKey value={`${project.key}-…`} /> : null}
        onClose={onClose}
        footer={
          <button type="submit" form="newtask-form" className="btn btn-primary newtask-create" disabled={!ready}>
            <Plus {...ICON_SM} />
            {createLabel}
          </button>
        }
      >
        <form id="newtask-form" className="newtask-form is-phone" onSubmit={submit}>
          {projectControl}
          {typeControl}
          {titleField}
          {descriptionField}
          <div className="newtask-cells">
            {cells.status}
            {cells.priority}
            {cells.epic}
            {cells.milestone}
            {cells.assignee}
            <div className="newtask-cell is-static">
              <span className="newtask-cell-key">{t('fields.labels')}</span>
              <span className="newtask-cell-value">
                <LabelsEditor labels={draft.labels} onChange={(labels) => set('labels', labels)} />
              </span>
            </div>
            <Cell label={t('newTask.relations')} onClick={() => setRelating(true)} disabled={!project}>
              {draft.relations.length === 0 ? (
                <span className="muted">{t('newTask.noRelations')}</span>
              ) : (
                <span className="newtask-cell-relations">
                  {draft.relations.map((r) => `${t(r.type === 'blocks' ? 'relations.blocks' : 'relations.blockedBy')} ${r.item.key}`).join(' · ')}
                </span>
              )}
            </Cell>
          </div>
          {draft.relations.length > 0 && <div className="workitem-card relations">{relationRows}</div>}
          <div className="workitem-section-head">
            <span className="section-label grow">{t('criteria.title')}</span>
            <span className="mono small muted">{cleanCriteria(draft.criteria).length}</span>
          </div>
          <div className="newtask-cells">
            {draft.criteria.map((value, index) => (
              <div key={index} className="newtask-cell is-static">
                {criterionInput(value, index, 'newtask-criterion')}
                {removeCriterion(index)}
              </div>
            ))}
            <button type="button" className="newtask-cell newtask-add" onClick={addCriterion}>
              <Plus {...ICON_SM} />
              {t('criteria.add')}
            </button>
          </div>
          <ErrorBox error={create.error} title={t('errors.create')} />
        </form>
        {relationDialog}
      </FullScreen>
    );
  }

  const fields = pickers((label, value) => <FieldButton label={label}>{value}</FieldButton>);
  return (
    <Dialog
      title={
        <span className="newtask-dialog-title">
          <span>{t('newTask.title')}</span>
          {heading && <span className="mono small muted newtask-where">{heading}</span>}
        </span>
      }
      onClose={onClose}
      width={680}
      footer={
        <>
          <Checkbox checked={another} onChange={setAnother}>
            {t('newTask.another')}
          </Checkbox>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button type="submit" form="newtask-form" className="btn btn-primary" disabled={!ready}>
            <Plus {...ICON_SM} />
            {createLabel}
          </button>
        </>
      }
    >
      <form id="newtask-form" className="newtask-form" onSubmit={submit}>
        {projectControl}
        {typeControl}
        {titleField}
        <div className="form-row">
          <span className="newtask-row-head">
            <span className="section-label grow">{t('fields.description')}</span>
            <span className="mono small muted newtask-md">
              <FileText size={12} strokeWidth={1.75} aria-hidden />
              {t('description.markdown')}
            </span>
          </span>
          {descriptionField}
        </div>
        <div className="newtask-grid">
          <div className="form-row">
            <span className="section-label">{t('newTask.column')}</span>
            {fields.status}
          </div>
          <div className="form-row">
            <span className="section-label">{t('fields.priority')}</span>
            {fields.priority}
          </div>
          <div className="form-row">
            <span className="section-label">{t('fields.assignee')}</span>
            {fields.assignee}
          </div>
          {fields.epic && (
            <div className="form-row">
              <span className="section-label">{t('fields.epic')}</span>
              {fields.epic}
            </div>
          )}
          <div className="form-row">
            <span className="section-label">{t('fields.milestone')}</span>
            {fields.milestone}
          </div>
          <div className="form-row">
            <span className="section-label">{t('fields.labels')}</span>
            <div className="newtask-labels">
              {draft.labels.map((label) => (
                <button
                  key={label}
                  type="button"
                  className="workitem-label workitem-label-remove"
                  aria-label={t('fields.removeLabel', { label })}
                  onClick={() =>
                    set(
                      'labels',
                      draft.labels.filter((l) => l !== label),
                    )
                  }
                >
                  {label}
                  <X size={10} strokeWidth={2} aria-hidden />
                </button>
              ))}
              <input
                value={labelDraft}
                aria-label={t('fields.addLabel')}
                placeholder={t('newTask.labelsPlaceholder')}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={() => {
                  set('labels', addLabel(draft.labels, labelDraft));
                  setLabelDraft('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    set('labels', addLabel(draft.labels, labelDraft));
                    setLabelDraft('');
                  } else if (e.key === 'Backspace' && !labelDraft && draft.labels.length) set('labels', draft.labels.slice(0, -1));
                }}
              />
            </div>
          </div>
        </div>
        <div className="form-row">
          <span className="newtask-row-head">
            <span className="section-label grow">{t('newTask.relations')}</span>
            <span className="mono small muted">{draft.relations.length}</span>
          </span>
          {draft.relations.length > 0 && <div className="workitem-card relations">{relationRows}</div>}
          <button type="button" className="btn btn-small workitem-add newtask-add-inline" onClick={() => setRelating(true)} disabled={!project}>
            <Plus {...ICON_SM} />
            {t('relations.add')}
          </button>
        </div>
        <div className="form-row">
          <span className="newtask-row-head">
            <span className="section-label grow">{t('criteria.title')}</span>
            <span className="mono small muted">{cleanCriteria(draft.criteria).length}</span>
          </span>
          {draft.criteria.map((value, index) => (
            <div key={index} className="newtask-criterion-row">
              {criterionInput(value, index)}
              {removeCriterion(index)}
            </div>
          ))}
          <button type="button" className="btn btn-small workitem-add newtask-add-inline" onClick={addCriterion}>
            <Plus {...ICON_SM} />
            {t('criteria.add')}
          </button>
        </div>
        {projectId === null && boards.length === 0 && <p className="muted small">{t('newTask.noBoard')}</p>}
        <ErrorBox error={create.error} title={t('errors.create')} />
      </form>
      {relationDialog}
    </Dialog>
  );
}
