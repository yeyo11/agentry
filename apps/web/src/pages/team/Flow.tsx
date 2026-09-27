import type { Project, ProjectFlowSettings, Team, WorkItem, WorkItemStatus } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CornerDownLeft, Lock, Undo2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useWorkItemBoard } from '../../api';
import { NumberInput, Select, Switch } from '../../components/controls';
import { ICON_SM, WorkItemKey, WorkItemStatusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ModelCombobox, Tag } from '../../components/ui';
import { useDirty } from '../../lib/dirty';
import { NARROW, useMediaQuery } from '../../lib/media';
import { columnMeta, taskPath } from '../../lib/work-items';
import { FLOW_COLUMNS, MAX_BOUNCES, sameFlow, setColumnRole } from './model';
import { PersonMark } from './parts';
import { ModelTag, RoleAvatar, useRoleName } from './RoleAvatar';

const NOBODY = '';

/** What the role of a column does there, and when it moves the card on: the Flow rows' two lines. */
function useColumnWords(): (status: WorkItemStatus) => { does: string; then: string } {
  const { t } = useTranslation('team');
  return (status) => {
    if (status === 'done') return { does: t('flow.column.done.does'), then: t('flow.column.done.then') };
    return { does: t(`flow.column.${status}.does`), then: t(`flow.column.${status}.then`) };
  };
}

/** Items QA sent back in their current round, and those that used every bounce and wait for the person. */
function bounced(items: readonly WorkItem[]): WorkItem[] {
  return items.filter((item) => (item.bounces ?? 0) > 0 || item.waiting === 'bounces').sort((a, b) => (b.bounces ?? 0) - (a.bounces ?? 0));
}

/**
 * The flow by column: on or off, which role answers for each column, how many times QA may send an
 * item back, and each role's model. Edited as a draft and saved whole, as the reference's "Save the
 * flow" does: the flow goes into the project's settings, each model into its member.
 */
export function FlowEditor({ project, team, flow: saved, switcher }: { project: Project; team: Team; flow: ProjectFlowSettings; switcher: ReactNode }) {
  const { t } = useTranslation(['team', 'tasks', 'config']);
  const roleName = useRoleName();
  const phone = useMediaQuery(NARROW);
  const words = useColumnWords();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProjectFlowSettings | null>(null);
  const [models, setModels] = useState<Record<string, string>>({});
  const flow = draft ?? saved;
  const board = useWorkItemBoard(project.id, {}, project.modules.includes('board'));
  const items = useMemo(() => bounced((board.data?.columns ?? []).flatMap((column) => column.items)), [board.data]);

  const modelChanges = team.members.filter((member) => models[member.agent] !== undefined && models[member.agent]?.trim() !== member.model);
  const flowChanged = draft !== null && !sameFlow(draft, saved);
  const changes = (flowChanged ? 1 : 0) + modelChanges.length;
  const dirty = changes > 0;
  useDirty('flow', dirty);

  const discard = () => {
    setDraft(null);
    setModels({});
  };

  const save = useMutation({
    mutationFn: async () => {
      if (flowChanged && draft) {
        // Read again right before writing: the settings are replaced whole, and another tab may have changed them
        const fresh = await api.projectSettings(project.id);
        await api.putProjectSettings(project.id, { ...fresh, flow: draft });
      }
      for (const member of modelChanges)
        await api.putTeamMember(project.id, member.agent, { role: member.role, model: (models[member.agent] ?? member.model).trim(), responsibility: member.responsibility, writes: member.writes ?? [] });
    },
    onSuccess: () => {
      discard();
      toast.success(t('flow.saved'));
    },
    onError: (error) => toast.error(t('flow.saveFailed'), error),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projectSettings(project.id) });
      void queryClient.invalidateQueries({ queryKey: keys.team(project.id) });
      void queryClient.invalidateQueries({ queryKey: keys.flow(project.id) });
    },
  });

  const edit = (next: ProjectFlowSettings) => setDraft(next);
  const roles = team.members.map((member) => member.role);
  const roleOptions = [
    ...roles.map((role) => ({
      value: role,
      label: (
        <span className="flow-role-option">
          <RoleAvatar role={role} size="sm" />
          {roleName(role)}
        </span>
      ),
    })),
    { value: NOBODY, label: <span className="team-muted">{t('flow.nobody')}</span> },
  ];

  const unsaved = dirty && <Tag tone="warn">{t('config:shared.unsaved')}</Tag>;
  const actions = (
    <>
      <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={discard}>
        <Undo2 {...ICON_SM} />
        {t('config:shared.discard')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
        <Check {...ICON_SM} />
        {t('flow.save')}
      </button>
    </>
  );

  const toggle = (
    <Switch checked={flow.enabled} onChange={(enabled) => edit({ ...flow, enabled })} aria-label={t('flow.auto')} className="check flow-switch">
      {!phone && <span className="flow-switch-word">{flow.enabled ? t('flow.enabled') : t('flow.disabled')}</span>}
    </Switch>
  );

  const autoCard = (
    <section className="card flow-auto" aria-labelledby="flow-auto-title">
      <div className="flow-auto-head">
        <div className="flow-auto-text">
          <h3 id="flow-auto-title">{t('flow.auto')}</h3>
          <p>{phone ? t('flow.autoBodyShort') : t('flow.autoBody')}</p>
        </div>
        {toggle}
      </div>
      {!phone && (
        <>
          <ol className="flow-strip" aria-label={t('flow.stripLabel')}>
            {FLOW_COLUMNS.map((status) => {
              const role = flow.columns[status];
              return (
                <li key={status} className="flow-node">
                  <WorkItemStatusIcon status={status} decorative />
                  <span className="flow-node-col">{t(`tasks:${columnMeta(status).label}`)}</span>
                  <span className="flow-node-who">
                    {role ? (
                      <>
                        <RoleAvatar role={role} size="sm" />
                        {roleName(role)}
                      </>
                    ) : (
                      <span className="team-muted">{t('flow.nobody')}</span>
                    )}
                  </span>
                </li>
              );
            })}
            <li className="flow-node is-person">
              <WorkItemStatusIcon status="done" decorative />
              <span className="flow-node-col">{t('tasks:status.done')}</span>
              <span className="flow-node-who">
                <PersonMark size={22} />
                {t('flow.you')}
              </span>
            </li>
          </ol>
          <div className="flow-back" aria-hidden />
          <p className="flow-back-note">
            <CornerDownLeft size={12} strokeWidth={1.75} aria-hidden />
            {t('flow.back')}
          </p>
        </>
      )}
    </section>
  );

  const rows = (
    <section className="card flow-rows" aria-labelledby="flow-rows-title">
      {!phone && (
        <div className="flow-rows-head">
          <h3 id="flow-rows-title">{t('flow.whoTitle')}</h3>
          <span className="team-muted">{t('flow.whoHint')}</span>
        </div>
      )}
      {phone && (
        <h3 id="flow-rows-title" className="sr-only">
          {t('flow.whoTitle')}
        </h3>
      )}
      {[...FLOW_COLUMNS, 'done' as const].map((status) => {
        const { does, then } = words(status);
        const label = t(`tasks:${columnMeta(status).label}`);
        return (
          <div key={status} className="flow-row" data-status={status}>
            <span className="flow-col">
              <WorkItemStatusIcon status={status} decorative />
              <span className="flow-col-name">{label}</span>
            </span>
            {status === 'done' ? (
              <span className="flow-role is-fixed" title={t('flow.column.done.then')}>
                <PersonMark size={22} />
                <span className="grow">{t('flow.you')}</span>
                <Lock size={13} strokeWidth={1.75} aria-hidden />
              </span>
            ) : (
              <Select
                className="flow-role"
                value={flow.columns[status] ?? NOBODY}
                onChange={(role) => edit(setColumnRole(flow, status, role))}
                options={roleOptions}
                aria-label={t('flow.roleFor', { column: label })}
              />
            )}
            <span className="flow-does">
              {!phone && <span>{does}</span>}
              <span className="flow-then">{phone ? then.replace(/^→\s*/, '') : then}</span>
            </span>
          </div>
        );
      })}
    </section>
  );

  const bounceCard = (
    <section className="card flow-bounces" aria-labelledby="flow-bounces-title">
      <div className="flow-bounces-head">
        <div className="flow-auto-text">
          <h3 id="flow-bounces-title">{t('flow.bouncesTitle')}</h3>
          <p>{phone ? t('flow.bouncesBodyShort') : t('flow.bouncesBody')}</p>
        </div>
        {phone && <NumberInput value={flow.maxBounces} min={0} max={MAX_BOUNCES} onChange={(value) => edit({ ...flow, maxBounces: value ?? 0 })} aria-label={t('flow.bouncesMax')} />}
      </div>
      {!phone && (
        <div className="flow-bounces-input">
          <NumberInput value={flow.maxBounces} min={0} max={MAX_BOUNCES} onChange={(value) => edit({ ...flow, maxBounces: value ?? 0 })} aria-label={t('flow.bouncesMax')} />
          <span className="team-muted">{t('flow.atMost')}</span>
        </div>
      )}
      {!phone && items.length > 0 && (
        <ul className="flow-bounced">
          {items.map((item) => (
            <li key={item.id}>
              <Link to={taskPath(item.key)} className="flow-bounced-row">
                <WorkItemKey value={item.key} />
                <span className="flow-bounced-title">{item.title}</span>
                {item.waiting === 'bounces' && <span className="badge badge-idle">{t('card.waitsForYou')}</span>}
                <span className="bounce-mark">{t('flow.bounceOf', { n: item.bounces ?? 0, max: saved.maxBounces })}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const modelCard = !phone && team.members.length > 0 && (
    <section className="card flow-models" aria-labelledby="flow-models-title">
      <h3 id="flow-models-title">{t('flow.modelsTitle')}</h3>
      <ul className="flow-model-rows">
        {team.members.map((member) => {
          const value = models[member.agent] ?? member.model;
          return (
            <li key={member.agent} className="flow-model-row">
              <RoleAvatar role={member.role} size="sm" />
              <span className="grow">{roleName(member.role)}</span>
              <ModelTag model={value} />
              <span className="flow-model-input">
                <ModelCombobox value={value} onChange={(model) => setModels((now) => ({ ...now, [member.agent]: model }))} aria-label={t('flow.modelFor', { role: roleName(member.role) })} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="field-hint">{t('flow.modelsHint')}</p>
    </section>
  );

  if (phone)
    return (
      <div className="flow-page is-phone">
        {switcher}
        {autoCard}
        {rows}
        {bounceCard}
        <div className="member-phone-foot">
          {unsaved}
          {actions}
        </div>
      </div>
    );

  return (
    <div className="flow-page">
      <div className="team-toolbar">
        {switcher}
        <span className="grow" />
        {unsaved}
        {actions}
      </div>
      <div className="team-layout">
        <div className="team-main">
          {autoCard}
          {rows}
        </div>
        <div className="team-side">
          {bounceCard}
          {modelCard}
        </div>
      </div>
    </div>
  );
}
