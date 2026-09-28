import type { ProjectTeamRole, Team, TeamMember, WorkItemStatus } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileWarning, Pencil, Plus, Sparkle, UserMinus } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiRequestError, keys } from '../../api';
import { MoreActions } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON_SM, WorkItemStatusIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Empty } from '../../components/ui';
import { columnMeta } from '../../lib/work-items';
import { assistantPath } from '../assistant/model';
import { writeScope } from './model';
import { MemberNow } from './parts';
import { ModelTag, RoleAvatar, useResponsibility, useRoleName } from './RoleAvatar';

/** "Answers for": the member's columns with their glyphs, or that it is only consulted. */
export function AnswersFor({ columns }: { columns: WorkItemStatus[] }) {
  const { t } = useTranslation(['team', 'tasks']);
  if (columns.length === 0) return <span className="team-muted">{t('member.consulted')}</span>;
  return (
    <>
      {columns.map((status) => (
        <span key={status} className="member-column">
          <WorkItemStatusIcon status={status} decorative />
          {t(`tasks:${columnMeta(status).label}`)}
        </span>
      ))}
    </>
  );
}

/**
 * Where a member may write, as the flow holds it to: its paths, only the documents folder (`[]`), or
 * anywhere (no `writes`). The two last read opposite ways, so each has its own words.
 */
export function WritesFacts({ writes }: { writes: string[] | undefined }) {
  const { t } = useTranslation('team');
  const scope = writeScope(writes);
  if (scope === 'anywhere') return <span className="team-muted">{t('member.writesAnywhere')}</span>;
  if (scope === 'documents') return <span className="team-muted">{t('member.writesDocuments')}</span>;
  return (
    <>
      {(writes ?? []).map((path) => (
        <span key={path} className="scope-chip">
          {path}
        </span>
      ))}
    </>
  );
}

/** Its file, when it is not as the metadata says: missing, or changed by hand. Said in words, in warn. */
export function FileState({ member }: { member: TeamMember }) {
  const { t } = useTranslation('team');
  if (member.file.state === 'ok') return null;
  return (
    <span className="badge badge-warn member-file-state">
      <FileWarning size={12} strokeWidth={2} aria-hidden />
      {member.file.state === 'missing' ? t('file.missing') : t('file.drifted')}
    </span>
  );
}

function useRemoveMember(projectId: string) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (member: TeamMember) => api.removeTeamMember(projectId, member.agent),
    onSuccess: (_, member) => {
      void queryClient.invalidateQueries({ queryKey: keys.team(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.projectSettings(projectId) });
      toast.success(t('remove.done', { name: roleName(member.role) }));
    },
    onError: (error) => toast.error(t('remove.failed'), error),
  });
  return (member: TeamMember) =>
    void confirm({
      title: t('remove.title', { name: roleName(member.role) }),
      body: t('remove.body', { path: member.file.path }),
      confirmLabel: t('remove.confirm'),
      danger: true,
    }).then((ok) => ok && remove.mutate(member));
}

/**
 * One member on the Team screen: who it is and its agent file, what it answers for, where it may
 * write, and what it does now. The one at work carries the live rail; the rest stand still.
 */
function MemberCard({ member, href, onRemove }: { member: TeamMember; href: string; onRemove: () => void }) {
  const { t } = useTranslation('team');
  const navigate = useNavigate();
  const name = useRoleName()(member.role);
  const responsibility = useResponsibility()(member);
  const live = member.running.length > 0;
  return (
    <article className={`member-card ${live ? 'live-rail' : ''}`.trim()} aria-label={name} data-agent={member.agent}>
      <div className="member-head">
        <RoleAvatar role={member.role} size="lg" />
        <Link to={href} className="member-head-link">
          <span className="member-title">
            <span className="member-name">{name}</span>
            <ModelTag model={member.model} />
            <FileState member={member} />
          </span>
          <span className="member-file">{member.file.path}</span>
        </Link>
        <MoreActions
          label={t('member.actions', { name })}
          entries={[
            { id: 'open', label: t('member.open'), icon: Pencil, onSelect: () => navigate(href) },
            { id: 'remove', label: t('remove.action'), icon: UserMinus, destructive: true, onSelect: onRemove },
          ]}
        />
      </div>
      {responsibility && <p className="member-desc">{responsibility}</p>}
      <div className="member-facts-list">
        <div className="member-facts">
          <span className="section-label">{t('member.answersFor')}</span>
          <AnswersFor columns={member.columns} />
        </div>
        <div className="member-facts">
          <span className="section-label">{t('member.writes')}</span>
          <WritesFacts writes={member.writes} />
        </div>
      </div>
      <MemberNow member={member} />
    </article>
  );
}

/** The last card of the grid: agent files already in `.claude/agents/` that no member plays. */
function AddCard({ unassigned, onAdd }: { unassigned: string[]; onAdd: () => void }) {
  const { t } = useTranslation('team');
  return (
    <button type="button" className="member-card member-add" onClick={onAdd}>
      <span className="member-add-icon" aria-hidden>
        <Plus size={16} strokeWidth={1.75} />
      </span>
      <span className="member-add-title">{unassigned.length > 0 ? t('add.existingTitle') : t('add.title')}</span>
      <span className="member-add-hint">
        {unassigned.length > 0 ? t('add.existingHint', { count: unassigned.length, names: unassigned.join(', ') }) : t('add.newHint')}
      </span>
    </button>
  );
}

export function MemberGrid({ team, memberHref, onAdd }: { team: Team; memberHref: (agent: string) => string; onAdd: () => void }) {
  const remove = useRemoveMember(team.projectId);
  return (
    <div className="member-grid">
      {team.members.map((member) => (
        <MemberCard key={member.agent} member={member} href={memberHref(member.agent)} onRemove={() => remove(member)} />
      ))}
      <AddCard unassigned={team.unassignedAgents} onAdd={onAdd} />
    </div>
  );
}

/** The phone's members: one card of cells, each a way into the member, the working ones with the live rail. */
export function MemberCells({ team, memberHref }: { team: Team; memberHref: (agent: string) => string }) {
  const { t } = useTranslation('team');
  const roleName = useRoleName();
  return (
    <nav aria-label={t('members.title')}>
      <ul className="card settings-cells member-cells">
        {team.members.map((member) => (
          <li key={member.agent}>
            <Link to={memberHref(member.agent)} className={`settings-cell member-cell ${member.running.length > 0 ? 'live-rail' : ''}`.trim()}>
              <RoleAvatar role={member.role} />
              <span className="member-cell-text">
                <span className="member-title">
                  <span className="member-cell-name">{roleName(member.role)}</span>
                  <ModelTag model={member.model} />
                </span>
                <MemberNow member={member} compact />
              </span>
              <ChevronRight {...ICON_SM} className="settings-cell-chevron" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * "Ask for a proposal": the assistant reads the project and proposes the team on its own page. A
 * run already reading the project is where the proposal will be, so a 409 goes there too.
 */
export function useProposeTeam(projectId: string) {
  const { t } = useTranslation('assistant');
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.startAssistantRun(projectId, { kind: 'project' }),
    onSuccess: (run) => {
      queryClient.setQueryData(keys.assistantRun(run.id), run);
      void queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(projectId) });
      navigate(assistantPath(projectId));
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409) navigate(assistantPath(projectId));
      else toast.error(t('startFailed'), error);
    },
  });
}

/** "Ask for a proposal" on a team that has members, beside "Add member", as the references draw it. */
export function ProposeButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation('assistant');
  const propose = useProposeTeam(projectId);
  return (
    <button type="button" className="btn team-propose" disabled={propose.isPending} onClick={() => propose.mutate()}>
      <Sparkle {...ICON_SM} />
      {t('teamEmpty.propose')}
    </button>
  );
}

/**
 * A project with the Team module on and nobody on it: the assistant's proposal first, the template's
 * team beside it with the roles it brings listed under, as DesktopEquipoVacio draws it.
 */
export function TeamEmpty({ projectId, roles, templateName, phone, onAdd }: { projectId: string; roles: ProjectTeamRole[]; templateName: string | null; phone: boolean; onAdd: () => void }) {
  const { t } = useTranslation(['team', 'assistant']);
  const roleName = useRoleName();
  const toast = useToast();
  const queryClient = useQueryClient();
  const propose = useProposeTeam(projectId);
  const apply = useMutation({
    mutationFn: () => api.teamFromTemplate(projectId),
    onSuccess: (team) => {
      queryClient.setQueryData(keys.team(projectId), team);
      void queryClient.invalidateQueries({ queryKey: keys.projectSettings(projectId) });
      toast.success(t('empty.applied', { count: team.members.length }));
    },
    onError: (error) => toast.error(t('empty.failed'), error),
  });
  const list = (
    <div className="team-template">
      <span className="section-label">{templateName && !phone ? t('empty.templateBrings', { name: templateName }) : t('empty.templateBringsShort')}</span>
      <ul className={phone ? 'card settings-cells team-template-cells' : 'team-template-chips'}>
        {roles.map((role) => (
          <li key={role.role} className={phone ? 'settings-cell' : 'team-template-chip'}>
            <RoleAvatar role={role.role} />
            <span className={phone ? 'grow' : ''}>{roleName(role.role)}</span>
            <ModelTag model={role.model} />
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <>
      <section className={phone ? 'team-empty is-phone' : 'card glow-top team-empty'}>
        <Empty
          illustration="team"
          size={phone ? 'md' : 'lg'}
          title={t('empty.title')}
          action={
            <div className="team-empty-actions">
              <button type="button" className="btn btn-primary team-empty-propose" disabled={propose.isPending} onClick={() => propose.mutate()}>
                <Sparkle {...ICON_SM} />
                {t('assistant:teamEmpty.propose')}
              </button>
              <button type="button" className="btn team-empty-template" disabled={apply.isPending || roles.length === 0} onClick={() => apply.mutate()}>
                {t('empty.useTemplate')}
              </button>
              {/* A phone reaches it through the header's "⋯", as MobileEquipoVacio has only the two */}
              {!phone && (
                <button type="button" className="btn btn-quiet" onClick={onAdd}>
                  <Plus {...ICON_SM} />
                  {t('add.title')}
                </button>
              )}
            </div>
          }
        >
          {phone ? <Trans t={t} i18nKey="empty.bodyShort" components={{ code: <code /> }} /> : <Trans t={t} i18nKey="assistant:teamEmpty.body" components={{ code: <code /> }} />}
        </Empty>
        {!phone && roles.length > 0 && list}
        {!phone && <p className="team-empty-foot">{t('assistant:teamEmpty.foot')}</p>}
      </section>
      {phone && roles.length > 0 && list}
    </>
  );
}
