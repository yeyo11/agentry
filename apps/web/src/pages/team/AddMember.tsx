import type { Team } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Combobox, Select } from '../../components/controls';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { Field, ModelCombobox } from '../../components/ui';
import { AGENT_NAME, agentNameFor, isKnownRole, KNOWN_ROLES, roleIdFor } from './model';
import { useRoleName } from './RoleAvatar';

const NEW_FILE = '';

/**
 * "Add a member": a role, the agent file that plays it (one already in `.claude/agents/` that no
 * member uses, or a new one Agentry writes), its model and what it answers for. The file itself is
 * edited afterwards on the member's page, in the existing editor.
 */
export function AddMemberDialog({ projectId, team, initialAgent, onClose, onAdded }: { projectId: string; team: Team; initialAgent?: string; onClose: () => void; onAdded: (agent: string) => void }) {
  const { t } = useTranslation(['team', 'common']);
  const roleName = useRoleName();
  const toast = useToast();
  const queryClient = useQueryClient();
  const taken = new Set(team.members.map((member) => member.role));
  const free = KNOWN_ROLES.filter((role) => !taken.has(role));
  const [role, setRole] = useState<string>(initialAgent ? '' : (free[0] ?? ''));
  const [existing, setExisting] = useState<string>(initialAgent ?? NEW_FILE);
  const [model, setModel] = useState(role === 'product-owner' || role === 'architect' ? 'opus' : 'sonnet');
  const [responsibility, setResponsibility] = useState('');

  const roleId = isKnownRole(role) ? role : roleIdFor(role);
  const agent = existing || agentNameFor(roleId);
  const clash = roleId !== '' && taken.has(roleId);
  const fileTaken = !existing && team.members.some((member) => member.agent === agent);
  const invalid = !roleId || clash || !AGENT_NAME.test(agent) || fileTaken || !model.trim();

  const add = useMutation({
    mutationFn: () =>
      api.putTeamMember(projectId, agent, {
        role: roleId,
        model: model.trim(),
        responsibility: responsibility.trim(),
        createFile: !existing,
      }),
    onSuccess: (member) => {
      void queryClient.invalidateQueries({ queryKey: keys.team(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.projectSettings(projectId) });
      toast.success(t('add.added', { name: roleName(member.role) }));
      onAdded(member.agent);
    },
    onError: (error) => toast.error(t('add.failed'), error),
  });

  const pickRole = (value: string) => {
    setRole(value);
    if (isKnownRole(value)) setModel(value === 'product-owner' || value === 'architect' || value === 'researcher' ? 'opus' : 'sonnet');
  };

  return (
    <Dialog
      title={t('add.title')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={invalid || add.isPending} onClick={() => add.mutate()}>
            {t('add.submit')}
          </button>
        </>
      }
    >
      <div className="team-form">
        <Field label={t('add.role')} hint={clash ? t('add.roleTaken') : t('add.roleHint')}>
          <Combobox
            value={role}
            onChange={pickRole}
            options={free.map((value) => ({ value, label: roleName(value) }))}
            placeholder={t('add.rolePlaceholder')}
            aria-label={t('add.role')}
          />
        </Field>
        <Field label={t('add.file')} hint={existing ? t('add.fileKept') : t('add.fileNew', { path: `.claude/agents/${agent || '…'}.md` })}>
          <Select
            value={existing}
            onChange={setExisting}
            aria-label={t('add.file')}
            options={[{ value: NEW_FILE, label: t('add.newFile') }, ...team.unassignedAgents.map((name) => ({ value: name, label: <span className="mono">{name}.md</span> }))]}
          />
        </Field>
        <Field label={t('member.model')}>
          <ModelCombobox value={model} onChange={setModel} aria-label={t('member.model')} />
        </Field>
        <Field label={t('member.responsibility')} hint={t('member.responsibilityHint')}>
          <textarea rows={3} value={responsibility} onChange={(event) => setResponsibility(event.target.value)} placeholder={t('add.responsibilityPlaceholder')} />
        </Field>
      </div>
    </Dialog>
  );
}
