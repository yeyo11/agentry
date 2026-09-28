import type { Project, TeamMember } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookText, Check, ChevronLeft, ChevronRight, FileWarning, Pencil, Undo2, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useMemoryProposals } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { ModelPicker, MoreActions } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON, ICON_SM } from '../../components/icons';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { useToast } from '../../components/Toast';
import { ErrorBox, Skeleton, Tag } from '../../components/ui';
import { useDirty } from '../../lib/dirty';
import { timeAgo } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { AnswersFor, FileState } from './Members';
import { frontmatterProblem } from '../config/frontmatter';
import {
  commandScope,
  commandsFor,
  commandsProblem,
  memberBody,
  sameCommands,
  sameWrites,
  stageOf,
  writeScope,
  writesFor,
  type CommandScope,
  type WriteScope,
} from './model';
import { CommandsField, WritesField } from './MemberFields';
import { NowAndBefore, RunRow } from './MemberRuns';
import { RoleAvatar, useResponsibility, useRoleName } from './RoleAvatar';

interface Draft {
  responsibility: string;
  model: string;
  scope: WriteScope;
  paths: string[];
  commandScope: CommandScope;
  commands: string[];
  content: string;
}

const AGENTS = 'agents' as const;

/** The member's agent file, read under the resources' own key so saving it from Resources refreshes it here too. */
function useAgentFile(projectId: string, member: TeamMember) {
  const scope = { projectId };
  return useQuery({
    queryKey: [...keys.resources(scope, AGENTS), member.agent],
    queryFn: () => api.resource(scope, AGENTS, member.agent),
    enabled: member.file.state !== 'missing',
    retry: false,
  });
}

/**
 * One member: its responsibility, the paths it may write and its agent file in the existing editor,
 * with its model, its columns, what it does and its memory beside. Saving writes the metadata
 * through the team route and the file through the resources route, the one a terminal would read.
 */
export function MemberPage({ project, member, backHref }: { project: Project; member: TeamMember; backHref: string }) {
  const { t } = useTranslation(['team', 'config']);
  const roleName = useRoleName();
  const name = roleName(member.role);
  const phone = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const file = useAgentFile(project.id, member);
  const memoryOn = project.modules.includes('memory');
  const proposals = useMemoryProposals(memoryOn ? project.id : null, 'pending');
  const mine = (proposals.data ?? []).filter((proposal) => proposal.proposedBy.role === member.role);
  const [editing, setEditing] = useState(false);
  // A responsibility still the template's is shown, and edited, in the person's language; left as
  // shown, it is saved as core wrote it, in the English Claude reads
  const shownResponsibility = useResponsibility()(member);

  const saved: Draft = {
    responsibility: shownResponsibility,
    model: member.model,
    scope: writeScope(member.writes),
    paths: member.writes ?? [],
    commandScope: commandScope(member.commands),
    commands: member.commands ?? [],
    content: file.data?.content ?? '',
  };
  // Only the fields the person touched: the rest follows what is saved, so a model changed on the
  // Flow screen, a file Agentry rewrote or another tab's save shows here instead of being overwritten
  const [draft, setDraft] = useState<Partial<Draft>>({});
  const now: Draft = { ...saved, ...draft };
  const writes = writesFor(now.scope, now.paths);
  const commands = commandsFor(now.commandScope, now.commands);
  const responsibility = now.responsibility.trim() === shownResponsibility.trim() ? member.responsibility : now.responsibility.trim();
  const metaChanged =
    responsibility !== member.responsibility || now.model.trim() !== saved.model || !sameWrites(writes, member.writes) || !sameCommands(commands ?? undefined, member.commands);
  const commandsBad = commands !== null && commandsProblem(commands) !== null;
  const fileChanged = member.file.state !== 'missing' && draft.content !== undefined && draft.content !== saved.content;
  const dirty = metaChanged || fileChanged;
  useDirty(`member:${member.agent}`, dirty);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const frontmatter = fileChanged ? frontmatterProblem('agents', now.content) : null;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.team(project.id) });
    await queryClient.invalidateQueries({ queryKey: keys.resources({ projectId: project.id }, AGENTS) });
    await queryClient.invalidateQueries({ queryKey: keys.projectSettings(project.id) });
  };

  const save = useMutation({
    mutationFn: async () => {
      // The metadata first: Agentry may rewrite a file it wrote itself to follow it, and the person's
      // own edit to the file must be the last word
      if (metaChanged)
        await api.putTeamMember(project.id, member.agent, memberBody(member, { model: now.model.trim(), responsibility, writes: writes ?? null, commands }));
      if (fileChanged) await api.putResource({ projectId: project.id }, AGENTS, member.agent, now.content);
    },
    onSuccess: async () => {
      await refresh();
      setDraft({});
      setEditing(false);
      toast.success(t('member.saved', { name }));
    },
    onError: (error) => toast.error(t('member.saveFailed'), error),
  });

  const writeFile = useMutation({
    mutationFn: () =>
      api.putTeamMember(project.id, member.agent, { ...memberBody(member), createFile: true }),
    onSuccess: () => refresh(),
    onError: (error) => toast.error(t('file.writeFailed'), error),
  });

  const remove = useMutation({
    mutationFn: () => api.removeTeamMember(project.id, member.agent),
    onSuccess: () => {
      void refresh();
      toast.success(t('remove.done', { name }));
      navigate(backHref);
    },
    onError: (error) => toast.error(t('remove.failed'), error),
  });
  const askRemove = () =>
    void confirm({ title: t('remove.title', { name }), body: t('remove.body', { path: member.file.path }), confirmLabel: t('remove.confirm'), danger: true }).then(
      (ok) => ok && remove.mutate(),
    );

  const stage = member.columns[0] ? stageOf(member.columns[0]) : null;
  const unsaved = dirty && (
    <Tag tone="warn">
      <span className="member-unsaved">{t('config:shared.unsaved')}</span>
    </Tag>
  );
  const actions = (
    <>
      <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={() => setDraft({})}>
        <Undo2 {...ICON_SM} />
        {t('config:shared.discard')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending || !now.model.trim() || frontmatter !== null || commandsBad} onClick={() => save.mutate()}>
        <Check {...ICON_SM} />
        {t('config:shared.save')}
      </button>
    </>
  );

  const fileNotice =
    member.file.state === 'missing' ? (
      <div className="alert alert-warn member-file-alert" role="status">
        <FileWarning size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
        <div className="alert-body">
          <strong>{t('file.missingTitle')}</strong>
          <div>{t('file.missingBody', { path: member.file.path })}</div>
        </div>
        <button type="button" className="btn btn-small" disabled={writeFile.isPending} onClick={() => writeFile.mutate()}>
          {t('file.write')}
        </button>
      </div>
    ) : member.file.state === 'drifted' ? (
      <div className="alert alert-warn member-file-alert" role="status">
        <FileWarning size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
        <div className="alert-body">
          <strong>{t('file.driftedTitle')}</strong>
          <div>{t('file.driftedBody', { fields: member.file.drift.join(', ') })}</div>
        </div>
      </div>
    ) : null;

  const editor =
    member.file.state === 'missing' ? null : file.error ? (
      <ErrorBox error={file.error} />
    ) : file.isLoading ? (
      <Skeleton rows={8} height={16} />
    ) : phone && !editing ? (
      <pre className="member-file-preview" aria-label={t('member.filePreview', { path: member.file.path })}>
        {now.content.split('\n').slice(0, 6).join('\n')}
      </pre>
    ) : (
      <div className="member-editor">
        <div className="member-editor-bar">
          <span className="ellipsis">{member.file.path}</span>
          <span className="grow" />
          <span>{t('member.markdown')}</span>
        </div>
        <CodeEditor
          value={now.content}
          onChange={(content) => set({ content })}
          language="markdown"
          ariaLabel={t('member.fileContent')}
          minHeight={phone ? '280px' : '420px'}
          onSave={() => dirty && frontmatter === null && !commandsBad && save.mutate()}
        />
        {frontmatter && (
          <span className="field-error" role="alert">
            {t(`config:resources.frontmatter.${frontmatter}`)}
          </span>
        )}
      </div>
    );

  const removeEntry = { id: 'remove', label: t('remove.action'), icon: UserMinus, destructive: true, onSelect: askRemove };
  // A phone heads the member as every pushed screen: back, the role, its file, and "⋯" as a sheet
  const head = phone ? (
    <PhoneHeader
      title={name}
      subtitle={member.file.path}
      back={{ label: t('member.back'), fallback: backHref }}
      more={[removeEntry]}
      moreLabel={t('member.actions', { name })}
    />
  ) : (
    <header className="member-page-head">
      <Link to={backHref} className="icon-btn" aria-label={t('member.back')}>
        <ChevronLeft {...ICON} />
      </Link>
      <RoleAvatar role={member.role} size="lg" />
      <div className="member-page-title">
        <h1>{name}</h1>
        <span className="member-file">{member.file.path}</span>
      </div>
      <FileState member={member} />
      {unsaved}
      {actions}
      <MoreActions label={t('member.actions', { name })} entries={[removeEntry]} />
    </header>
  );

  const responsibilityField = (
    <label className="member-field">
      <span className="section-label">{t('member.responsibility')}</span>
      <textarea className="member-textarea" rows={3} value={now.responsibility} onChange={(event) => set({ responsibility: event.target.value })} />
      {!phone && <span className="field-hint">{t('member.responsibilityHint')}</span>}
    </label>
  );
  const writesField = (
    <WritesField scope={now.scope} paths={now.paths} onChange={(patch) => set(patch)} badge={phone ? unsaved : undefined} />
  );
  const commandsField = (
    <CommandsField scope={now.commandScope} commands={now.commands} onChange={(patch) => set({ ...(patch.scope ? { commandScope: patch.scope } : {}), ...(patch.commands ? { commands: patch.commands } : {}) })} />
  );

  const running = member.running[0];
  const props = (
    <div className="member-props">
      {!phone && (
        <div className="prop-row">
          <span className="prop-key">{t('member.role')}</span>
          <span>{name}</span>
        </div>
      )}
      <div className="prop-row">
        <span className="prop-key">{t('member.model')}</span>
        <ModelPicker className="member-model-pick" value={now.model} onChange={(model) => set({ model })} aria-label={t('flow.modelFor', { role: name })} />
      </div>
      <div className="prop-row">
        <span className="prop-key">{t('member.column')}</span>
        <span className="member-columns">
          <AnswersFor columns={member.columns} />
        </span>
      </div>
      {!phone && stage && (
        <>
          <div className="prop-row">
            <span className="prop-key">{t('member.onEnter')}</span>
            <span className="member-prop-text">{t(`stage.${stage}.onEnter`)}</span>
          </div>
          <div className="prop-row">
            <span className="prop-key">{t('member.onEnd')}</span>
            <span className="member-prop-text">{t(`stage.${stage}.onEnd`)}</span>
          </div>
        </>
      )}
      {phone && memoryOn && (
        <Link to="?view=memory" className="prop-row member-memory-cell">
          <span className="prop-key">{t('member.memory')}</span>
          <span className="grow" />
          {mine.length > 0 ? <span className="badge badge-idle">{t('member.waiting', { count: mine.length })}</span> : <span className="team-muted">{t('member.noProposals')}</span>}
          <ChevronRight {...ICON_SM} />
        </Link>
      )}
    </div>
  );

  const aside = (
    <aside className="member-aside" aria-label={t('member.properties')}>
      {props}
      <NowAndBefore projectId={project.id} member={member} />
      {memoryOn && (
        <section className="member-aside-section">
          <span className="section-label">{t('member.memory')}</span>
          <Link to="?view=memory" className="member-run">
            <BookText {...ICON_SM} className="member-run-icon" />
            <span className="member-run-text">
              <span>{mine.length > 0 ? t('member.proposalsWaiting', { count: mine.length }) : t('member.noProposals')}</span>
              {mine[0]?.item && (
                <span className="member-run-state mono">
                  {t('member.proposalFrom', { key: mine[0].item.key })} · {timeAgo(mine[0].createdAt)}
                </span>
              )}
            </span>
            {mine.length > 0 && <span className="badge badge-idle">{t('member.waitingWord')}</span>}
          </Link>
          <p className="field-hint">{t('member.memoryHint')}</p>
        </section>
      )}
    </aside>
  );

  if (phone)
    return (
      <div className="member-page is-phone">
        {head}
        {running && <RunRow run={running} />}
        <div className="card member-phone-props">{props}</div>
        {fileNotice}
        {responsibilityField}
        {writesField}
        {commandsField}
        {member.file.state !== 'missing' && (
          <div className="member-field">
            <span className="member-field-head">
              <span className="section-label">{t('member.file')}</span>
              {!editing && (
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  <Pencil {...ICON_SM} />
                  {t('member.edit')}
                </button>
              )}
            </span>
            {editor}
          </div>
        )}
        <div className="member-phone-foot">{actions}</div>
      </div>
    );

  return (
    <div className="member-page">
      <div className="member-main">
        {head}
        {fileNotice}
        <div className="member-form">
          {responsibilityField}
          <div className="member-form-col">
            {writesField}
            {commandsField}
          </div>
        </div>
        {member.file.state !== 'missing' && (
          <section className="member-file-section">
            <div className="member-file-head">
              <h2>{t('member.file')}</h2>
              <span className="field-hint">{t('member.fileHint')}</span>
            </div>
            {editor}
          </section>
        )}
      </div>
      {aside}
    </div>
  );
}
