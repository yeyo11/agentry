import type { FlowWaiting, Project, ProjectFlowSettings, Team, WorkItemStatus } from '@agentry/shared';
import { DEFAULT_FLOW_MAX_PARALLEL, MAX_FLOW_PARALLEL } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CornerDownLeft, Info, Lock, Undo2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { ModelPicker, NumberInput, Select, Switch } from '../../components/controls';
import { ICON_SM, WorkItemStatusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Tag } from '../../components/ui';
import { useDirty } from '../../lib/dirty';
import { NARROW, useMediaQuery } from '../../lib/media';
import { columnMeta } from '../../lib/work-items';
import { FlowWaitingPrompt, switchesFlowOn, waitingToAsk } from './FlowWaiting';
import { FLOW_COLUMNS, MAX_BOUNCES, memberBody, sameFlow, setColumnRole, settledFlow } from './model';
import { PersonMark } from './parts';
import { RoleAvatar, useRoleName } from './RoleAvatar';

const NOBODY = '';

/** The cost as typed, kept raw until it is settled; an emptied field takes the key away. */
function withCost(flow: ProjectFlowSettings, value: number | undefined): ProjectFlowSettings {
  const next = { ...flow };
  if (value === undefined) delete next.maxCostUsd;
  else next.maxCostUsd = value;
  return next;
}

/** What the role of a column does there, and when it moves the card on: the Flow rows' two lines. */
function useColumnWords(): (status: WorkItemStatus) => { does: string; then: string } {
  const { t } = useTranslation('team');
  return (status) => {
    if (status === 'done') return { does: t('flow.column.done.does'), then: t('flow.column.done.then') };
    return { does: t(`flow.column.${status}.does`), then: t(`flow.column.${status}.then`) };
  };
}

/**
 * The flow by column: on or off, which role answers for each column, its limits (bounces, runs at
 * once, the cost of a run) and each role's model. Edited as a draft and saved whole, as the
 * reference's "Save the flow" does: the flow goes into the project's settings, each model into its
 * member. The items QA sent back are Team activity's "Devueltas", which "See runs" leads to.
 */
export function FlowEditor({
  project,
  team,
  flow: saved,
  proposal,
  switcher,
  activityHref,
  onChanges,
}: {
  project: Project;
  team: Team;
  flow: ProjectFlowSettings;
  /** For a project that never saved a flow, the template's: shown as a draft to save, not as the flow */
  proposal: ProjectFlowSettings | null;
  switcher: ReactNode;
  activityHref: string;
  /** Hears how many changes wait to be saved: a phone says it under its title, as the reference does */
  onChanges?: (count: number) => void;
}) {
  const { t } = useTranslation(['team', 'tasks', 'config']);
  const roleName = useRoleName();
  const phone = useMediaQuery(NARROW);
  const words = useColumnWords();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProjectFlowSettings | null>(null);
  const [models, setModels] = useState<Record<string, string>>({});
  const baseline = proposal ?? saved;
  // The draft keeps the limits as typed, so "0." on the way to "0.5" is not wiped; what is compared and saved is settled
  const flow = draft ?? baseline;
  const next = settledFlow(flow);
  // The cost as typed ("0," on the way to "0,5"), while the field has it; the draft keeps the number
  const [costText, setCostText] = useState<string | null>(null);
  // The cards already on the board when a save switched the flow on: asked about once, then gone
  const [waiting, setWaiting] = useState<FlowWaiting | null>(null);

  const modelChanges = team.members.filter((member) => models[member.agent] !== undefined && models[member.agent]?.trim() !== member.model);
  // What saving would write, the proposal included; leaving only warns about what the person edited
  const flowChanged = !sameFlow(next, saved);
  const edited = (draft !== null && !sameFlow(next, baseline)) || modelChanges.length > 0;
  const dirty = flowChanged || modelChanges.length > 0;
  useDirty('flow', edited);
  const changes = (flowChanged ? 1 : 0) + modelChanges.length;
  useEffect(() => onChanges?.(changes), [changes, onChanges]);

  const discard = () => {
    setDraft(null);
    setModels({});
    setCostText(null);
  };

  const save = useMutation({
    mutationFn: async (): Promise<{ switchedOn: boolean }> => {
      let switchedOn = false;
      if (flowChanged) {
        // Read again right before writing: the settings are replaced whole, and another tab may have changed them
        const fresh = await api.projectSettings(project.id);
        switchedOn = switchesFlowOn(saved, next);
        await api.putProjectSettings(project.id, { ...fresh, flow: next });
      }
      for (const member of modelChanges)
        await api.putTeamMember(project.id, member.agent, memberBody(member, { model: (models[member.agent] ?? member.model).trim() }));
      return { switchedOn };
    },
    onSuccess: ({ switchedOn }) => {
      discard();
      toast.success(t('flow.saved'));
      // Switching the flow on starts only the cards that enter a column from now on: the ones already
      // waiting start only if the person says so
      if (switchedOn) void waitingToAsk(() => api.flowWaiting(project.id)).then((found) => found && setWaiting(found));
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
      <button type="button" className="btn" disabled={!edited || save.isPending} onClick={discard}>
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
          <h2 id="flow-auto-title">{t('flow.auto')}</h2>
          <p>{phone ? t('flow.autoBodyShort') : t('flow.autoBody')}</p>
        </div>
        {toggle}
      </div>
      {proposal && (
        <div className="alert alert-info flow-proposal" role="status">
          <Info size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">{t('flow.proposalNote')}</div>
        </div>
      )}
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
          <h2 id="flow-rows-title">{t('flow.whoTitle')}</h2>
          <span className="team-muted">{t('flow.whoHint')}</span>
        </div>
      )}
      {phone && (
        <h2 id="flow-rows-title" className="sr-only">
          {t('flow.whoTitle')}
        </h2>
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
              {/* On a phone Done says what it means, as MobileFlujo does, not that it is fixed */}
              <span className="flow-then">{phone ? (status === 'done' ? t('flow.column.done.phone') : then.replace(/^→\s*/, '')) : then}</span>
            </span>
          </div>
        );
      })}
    </section>
  );

  const costField = (
    <span className="flow-limit-cost">
      <input
        type="text"
        inputMode="decimal"
        value={costText ?? (flow.maxCostUsd === undefined ? '' : String(flow.maxCostUsd))}
        placeholder={t('flow.noLimit')}
        aria-label={t('flow.costLabel')}
        onChange={(event) => {
          const text = event.target.value;
          setCostText(text);
          const value = Number(text.replace(',', '.'));
          edit(withCost(flow, text.trim() === '' || !Number.isFinite(value) ? undefined : value));
        }}
        onBlur={() => setCostText(null)}
      />
      <span className="flow-limit-unit">{t('flow.usd')}</span>
    </span>
  );

  // Bounces, runs at once and the cost of a run: the flow's three limits in one card, as steppers and a field
  const limitsCard = (
    <section className="card flow-limits" aria-labelledby="flow-limits-title">
      {phone ? (
        <h2 id="flow-limits-title" className="sr-only">
          {t('flow.limitsTitle')}
        </h2>
      ) : (
        <div className="flow-limits-head">
          <h2 id="flow-limits-title">{t('flow.limitsTitle')}</h2>
          <Link to={activityHref} className="team-link">
            {t('flow.seeRuns')}
          </Link>
        </div>
      )}
      <div className="flow-limit-row">
        <span className="flow-limit-text">
          <span className="flow-limit-name">{t('flow.bouncesTitle')}</span>
          <span className="field-hint">{phone ? t('flow.bouncesBodyShort') : t('flow.bouncesHint')}</span>
        </span>
        <NumberInput value={flow.maxBounces} min={0} max={MAX_BOUNCES} onChange={(value) => edit({ ...flow, maxBounces: value ?? 0 })} aria-label={t('flow.bouncesMax')} />
      </div>
      <div className="flow-limit-row">
        <span className="flow-limit-text">
          <span className="flow-limit-name">{phone ? t('flow.parallelShort') : t('flow.parallel')}</span>
          <span className="field-hint">{t('flow.parallelHint')}</span>
        </span>
        <NumberInput
          value={flow.maxParallel ?? DEFAULT_FLOW_MAX_PARALLEL}
          min={1}
          max={MAX_FLOW_PARALLEL}
          onChange={(value) => edit({ ...flow, maxParallel: value ?? DEFAULT_FLOW_MAX_PARALLEL })}
          aria-label={t('flow.parallel')}
        />
      </div>
      {phone ? (
        <label className="flow-limit-row is-stacked">
          <span className="flow-limit-name">{t('flow.costPhone')}</span>
          {costField}
          <span className="field-hint">{t('flow.costHintPhone')}</span>
        </label>
      ) : (
        <div className="flow-limit-row">
          <span className="flow-limit-text">
            <span className="flow-limit-name">{t('flow.cost')}</span>
            <span className="field-hint">{t('flow.costHint')}</span>
          </span>
          {costField}
        </div>
      )}
      {!phone && <p className="field-hint flow-limits-foot">{t('flow.limitsFoot')}</p>}
    </section>
  );

  const modelCard = !phone && team.members.length > 0 && (
    <section className="card flow-models" aria-labelledby="flow-models-title">
      <h2 id="flow-models-title">{t('flow.modelsTitle')}</h2>
      <ul className="flow-model-rows">
        {team.members.map((member) => {
          const value = models[member.agent] ?? member.model;
          return (
            <li key={member.agent} className="flow-model-row">
              <RoleAvatar role={member.role} size="sm" />
              <span className="grow">{roleName(member.role)}</span>
              <ModelPicker
                className="flow-model-pick"
                value={value}
                onChange={(model) => setModels((now) => ({ ...now, [member.agent]: model }))}
                aria-label={t('flow.modelFor', { role: roleName(member.role) })}
              />
            </li>
          );
        })}
      </ul>
      <p className="field-hint">{t('flow.modelsHint')}</p>
    </section>
  );

  const prompt = waiting && <FlowWaitingPrompt projectId={project.id} waiting={waiting} phone={phone} onClose={() => setWaiting(null)} />;

  if (phone)
    return (
      <div className="flow-page is-phone">
        {switcher}
        {autoCard}
        {rows}
        <span className="section-label flow-limits-label">{t('flow.limitsTitle')}</span>
        {limitsCard}
        <div className="member-phone-foot">{actions}</div>
        {prompt}
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
          {limitsCard}
          {modelCard}
        </div>
      </div>
      {prompt}
    </div>
  );
}
