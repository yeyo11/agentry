import type { AssistantResourceKind, AssistantResourceProposal, ConfigResource, ConfigScopeKind, Project, ResourceKind } from '@agentry/shared';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, Pencil, Plus, Sparkle } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { api, keys, useAssistantRuns, useTeam } from '../../api';
import { Menu } from '../../components/controls/Menu';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, Segmented, Tag } from '../../components/ui';
import { useLeaveGuard } from '../../lib/dirty';
import { NARROW, useMediaQuery } from '../../lib/media';
import { NameForm, ResourceEditor, ResourcesTab } from '../config/ResourcesTab';
import { CreateWithAI } from './resources/CreateWithAI';
import { AI_KINDS, byDecision, isAiKind, OTHER_KINDS, proposalRuns, resourceProposals, sectionFrom, sectionKinds, type ResourceSection } from './resources/model';
import { InProjectList, ProposalsCard } from './resources/parts';
import { ProposalEditor } from './resources/ProposalEditor';

/** The address of what the editor holds: `?res=agents:name`, `?proposal=<id>`; `?ai=1` opens "Create with AI". */
const PARAMS = ['res', 'proposal', 'scope', 'ai'] as const;

/**
 * What Claude can be given in this project. Its agents, skills and commands are one view, "All" or
 * one kind, with the assistant beside them: "Suggest" reads the project and proposes some, "Create
 * with AI" builds one from a description (decision 37), and every proposal opens in the editor
 * unsaved, so saving it is accepting it. Output styles, rules and workflows keep their own editor.
 */
export function ProjectResources({ project }: { project: Project }) {
  const { t } = useTranslation(['config', 'projects']);
  const phone = useMediaQuery(NARROW);
  const toast = useToast();
  const guard = useLeaveGuard();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const scope = useMemo(() => ({ projectId: project.id }), [project.id]);

  const section = sectionFrom(params.get('section'));
  const resParam = params.get('res');
  const proposalId = params.get('proposal');
  const aiOpen = params.get('ai') === '1';
  const scopeParam: ConfigScopeKind | undefined = params.get('scope') === 'user' ? 'user' : undefined;

  // The page's own `view` (and the project) stay; only what this tab owns changes
  const update = (patch: Partial<Record<'section' | (typeof PARAMS)[number], string | null>>, replace = false) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === undefined) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace },
    );
  const go = (patch: Parameters<typeof update>[0]) => void guard().then((ok) => ok && update(patch));
  const closeEditor = { res: null, proposal: null, scope: null } as const;

  // ---- the project's agents, skills and commands ----
  const lists = useQueries({
    queries: AI_KINDS.map((kind) => ({ queryKey: keys.resources(scope, kind), queryFn: () => api.resources(scope, kind) })),
  });
  const resources: Partial<Record<AssistantResourceKind, ConfigResource[]>> = {};
  AI_KINDS.forEach((kind, i) => {
    const data = lists[i]?.data;
    if (data) resources[kind] = data;
  });
  const listsLoading = lists.some((q) => q.isLoading);
  const listsError = lists.find((q) => q.error)?.error;
  const count = (kind: AssistantResourceKind) => resources[kind]?.length ?? 0;

  // ---- the assistant's runs and their proposals ----
  const resourceRuns = useAssistantRuns(project.id, 'resources');
  const projectRuns = useAssistantRuns(proposalId ? project.id : null, 'project');
  const { suggest, ids } = proposalRuns(resourceRuns.data ?? [], projectRuns.data ?? [], proposalId !== null);
  const details = useQueries({
    queries: ids.map((id) => ({ queryKey: keys.assistantRun(id), queryFn: ({ signal }: { signal: AbortSignal }) => api.assistantRun(id, { signal }) })),
  });
  const runsById = new Map(details.flatMap((q) => (q.data ? [[q.data.id, q.data] as const] : [])));
  const proposals = resourceProposals(details.flatMap((q) => q.data?.proposals ?? []));
  const kinds = sectionKinds(section);
  // The card: every proposal of the latest "Suggest", and what other runs left pending
  const cardProposals = byDecision(proposals.filter((p) => kinds.includes(p.resource.kind) && (p.runId === suggest?.id || p.status === 'pending')));
  const pendingProposals = cardProposals.filter((p) => p.status === 'pending');
  const openProposal = proposalId ? (proposals.find((p) => p.id === proposalId) ?? null) : null;
  const detailsLoading = details.some((q) => q.isLoading) || resourceRuns.isLoading || projectRuns.isLoading;

  const team = useTeam(project.modules.includes('team') ? project.id : null);
  const teamMembers = team.data?.enabled ? team.data.members.length : 0;

  const refreshRun = (runId: string) => {
    void queryClient.invalidateQueries({ queryKey: keys.assistantRun(runId) });
    void queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(project.id) });
  };
  const suggestRun = useMutation({
    mutationFn: () => api.startAssistantRun(project.id, { kind: 'resources', ...(suggest && suggest.status !== 'running' ? { supersede: true } : {}) }),
    onSuccess: (started) => {
      queryClient.setQueryData(keys.assistantRun(started.id), started);
      refreshRun(started.id);
    },
    onError: (err) => toast.error(t('resourcesAi.startFailed'), err),
  });
  const stopRun = useMutation({
    mutationFn: (runId: string) => api.stopAssistantRun(runId),
    onSuccess: (stopped) => refreshRun(stopped.id),
    onError: (err) => toast.error(t('resourcesAi.stopFailed'), err),
  });
  const decide = useMutation({
    mutationFn: ({ proposal, action }: { proposal: AssistantResourceProposal; action: 'discard' | 'restore' }) =>
      action === 'discard' ? api.discardAssistantProposal(proposal.id) : api.restoreAssistantProposal(proposal.id),
    onSuccess: (_answer, { proposal }) => refreshRun(proposal.runId),
    onError: (err) => toast.error(t('resourcesAi.decideFailed'), err),
  });
  // Each discarded on its own, as every decision on a proposal is (decision 36)
  const discardAll = useMutation({
    mutationFn: async (all: AssistantResourceProposal[]) => {
      for (const proposal of all) await api.discardAssistantProposal(proposal.id);
    },
    onSettled: (_answer, _error, all) => new Set(all.map((p) => p.runId)).forEach(refreshRun),
    onError: (err) => toast.error(t('resourcesAi.decideFailed'), err),
  });

  // ---- a new resource: its kind and name, then the editor with the kind's template ----
  const [naming, setNaming] = useState<{ kind: AssistantResourceKind; name: string } | null>(null);
  const [draft, setDraft] = useState<{ kind: AssistantResourceKind; name: string } | null>(null);
  const [savedNow, setSavedNow] = useState<ConfigResource | null>(null);
  const startNew = (kind: AssistantResourceKind) =>
    void guard().then((ok) => {
      if (!ok) return;
      update(closeEditor);
      setDraft(null);
      setNaming({ kind, name: '' });
    });

  // ---- the section: All, a kind the assistant handles, or one it does not ----
  const kindLabel = (kind: ResourceKind, n?: number) => (
    <span className="resources-seg-option">
      {t(`config.tabs.${kind}`)}
      {n !== undefined && <span className="count">{n}</span>}
    </span>
  );
  const aiSection: 'all' | AssistantResourceKind = isAiKind(section) ? section : 'all';
  const sectionControl = (
    <div className="resources-sections">
      <Segmented<'all' | AssistantResourceKind>
        label={t('projects:resources.sections')}
        value={aiSection}
        onChange={(next) => go({ section: next === 'all' ? null : next, ...closeEditor })}
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
  const otherOn = !isAiKind(section) && section !== 'all';
  // A phone has no room beside the kinds, so the other kinds are a "⋯" beside "New"
  const otherMenu = (
    <Menu
      label={t('resourcesAi.otherKinds')}
      align={phone ? 'end' : 'start'}
      entries={OTHER_KINDS.map((kind) => ({ id: kind, label: t(`config.tabs.${kind}`), onSelect: () => go({ section: kind, ...closeEditor }) }))}
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
  const newKinds = kinds.length > 0 ? kinds : [...AI_KINDS];
  const newButton =
    newKinds.length === 1 && newKinds[0] ? (
      <button type="button" className={phone ? 'icon-btn resources-new' : 'btn btn-quiet resources-new'} aria-label={phone ? t('resourcesAi.new') : undefined} onClick={() => newKinds[0] && startNew(newKinds[0])}>
        <Plus {...ICON_SM} />
        {!phone && t('resourcesAi.new')}
      </button>
    ) : (
      <Menu
        label={t('resourcesAi.new')}
        entries={newKinds.map((kind) => ({ id: kind, label: t(`resources.kinds.${kind}.new`), onSelect: () => startNew(kind) }))}
        trigger={
          <button type="button" className={phone ? 'icon-btn resources-new' : 'btn btn-quiet resources-new'} aria-label={phone ? t('resourcesAi.new') : undefined}>
            <Plus {...ICON_SM} />
            {!phone && t('resourcesAi.new')}
          </button>
        }
      />
    );
  const suggesting = suggest?.status === 'running' || suggestRun.isPending;
  const aiActions = (
    <div className="resources-ai-actions">
      <button type="button" className="btn resources-suggest" disabled={suggesting} onClick={() => suggestRun.mutate()}>
        <Sparkle {...ICON_SM} />
        {suggest && suggest.status !== 'running' ? t('resourcesAi.suggestAgain') : t('resourcesAi.suggest')}
      </button>
      <button type="button" className="btn resources-create-ai" onClick={() => update({ ai: '1' })}>
        <Pencil {...ICON_SM} />
        {t('resourcesAi.createAi')}
      </button>
    </div>
  );

  const createDialog = aiOpen && (
    <CreateWithAI
      project={project}
      initialKind={isAiKind(section) ? section : 'agents'}
      onClose={() => update({ ai: null }, true)}
      onOpen={(proposal, chosen) =>
        update({ ai: null, res: null, proposal: proposal.id, scope: chosen === 'user' ? 'user' : null, section: section === 'all' ? null : proposal.resource.kind })
      }
    />
  );

  // A kind the assistant does not handle keeps the editor it always had
  if (!isAiKind(section) && section !== 'all')
    return (
      <div className="resources-page">
        <div className="resources-toolbar">
          {sectionControl}
          {otherMenu}
        </div>
        <ResourcesTab key={`${project.id}:${section}`} scope={scope} kind={section} />
      </div>
    );

  // ---- what the editor holds ----
  const [resKind, ...resRest] = (resParam ?? '').split(':');
  const resName = resRest.join(':');
  const openResource = isAiKind(resKind) && resName ? { kind: resKind, name: resName } : null;
  const openFile = openResource ? (resources[openResource.kind]?.find((r) => r.name === openResource.name) ?? (savedNow?.name === openResource.name && savedNow.kind === openResource.kind ? savedNow : null)) : null;
  const editing = Boolean(proposalId || openResource || draft || naming);
  const current = openResource ? `${openResource.kind}:${openResource.name}` : null;

  let editor: ReactNode = null;
  if (proposalId) {
    editor = openProposal ? (
      <ProposalEditor
        key={openProposal.id}
        projectId={project.id}
        proposal={openProposal}
        run={runsById.get(openProposal.runId) ?? null}
        initialScope={scopeParam}
        onSaved={(name) => update({ ...closeEditor, ...(openProposal.resource.scope === 'project' || !scopeParam ? { res: `${openProposal.resource.kind}:${name}` } : {}) }, true)}
        onDiscarded={() => update(closeEditor, true)}
      />
    ) : detailsLoading ? null : (
      <p className="resources-missing">{t('resourcesAi.proposalGone')}</p>
    );
  } else if (draft) {
    editor = (
      <ResourceEditor
        key={`new:${draft.kind}:${draft.name}`}
        scope={scope}
        kind={draft.kind}
        name={draft.name}
        resource={null}
        onSaved={(saved) => {
          setSavedNow(saved);
          setDraft(null);
          update({ res: `${draft.kind}:${saved.name}` }, true);
        }}
        onClosed={() => setDraft(null)}
      />
    );
  } else if (openResource) {
    editor = openFile ? (
      <ResourceEditor
        key={`${openResource.kind}:${openResource.name}`}
        scope={scope}
        kind={openResource.kind}
        name={openResource.name}
        resource={openFile}
        onSaved={setSavedNow}
        onClosed={() => update(closeEditor, true)}
      />
    ) : listsLoading ? null : (
      <p className="resources-missing">{t('resourcesAi.resourceGone')}</p>
    );
  }

  if (!editor && naming) editor = <p className="resources-missing">{t('resourcesAi.nameFirst')}</p>;

  const proposalNav = pendingProposals.length > 0 && (
    <div className="resources-group">
      <div className="resources-group-head">
        <Sparkle {...ICON_SM} />
        <span className="section-label grow">{t('resourcesAi.proposalsShort')}</span>
        <span className="mono small muted">{pendingProposals.length}</span>
      </div>
      <ul className="master-list" aria-label={t('resourcesAi.proposalsShort')}>
        {pendingProposals.map((proposal) => (
          <li key={proposal.id}>
            <button
              type="button"
              aria-current={proposal.id === proposalId ? 'true' : undefined}
              className={`master-item resource-item ${proposal.id === proposalId ? 'master-item-on' : ''}`.trim()}
              onClick={() => go({ proposal: proposal.id, res: null, scope: null })}
            >
              <span className="master-item-head">
                <span className="mono resource-item-name">{proposal.resource.kind === 'commands' ? `/${proposal.resource.name}` : proposal.resource.name}</span>
                <span className="mono small muted">{t(`resourcesAi.kindLower.${proposal.resource.kind}`)}</span>
              </span>
              <span className="small muted resource-item-desc">{proposal.resource.description || proposal.reason}</span>
              {proposal.id === proposalId && (
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

  const master = (
    <nav className="resources-master" aria-label={t('projects:resources.sections')}>
      {naming && (
        <NameForm
          kind={naming.kind}
          value={naming.name}
          taken={(resources[naming.kind] ?? []).some((r) => r.name === naming.name)}
          onChange={(name) => setNaming({ ...naming, name })}
          onSubmit={() => {
            setDraft(naming);
            setNaming(null);
          }}
          onCancel={() => setNaming(null)}
        />
      )}
      <InProjectList
        kinds={kinds}
        resources={resources}
        loading={listsLoading}
        current={current}
        teamMembers={teamMembers}
        teamTo={`/?project=${encodeURIComponent(project.id)}&view=team`}
        onOpen={(kind, name) => {
          setDraft(null);
          setNaming(null);
          go({ res: `${kind}:${name}`, proposal: null, scope: null });
        }}
      >
        {proposalNav}
      </InProjectList>
    </nav>
  );

  const showCard = Boolean(suggest) || cardProposals.length > 0;
  const card = showCard && (
    <ProposalsCard
      run={suggest ? (runsById.get(suggest.id) ?? suggest) : null}
      proposals={cardProposals}
      loading={detailsLoading && cardProposals.length === 0}
      phone={phone}
      onReview={(proposal) => go({ proposal: proposal.id, res: null, scope: null })}
      onDecide={(proposal, action) => decide.mutate({ proposal, action })}
      onDiscardAll={() => discardAll.mutate(pendingProposals)}
      onStop={() => suggest && stopRun.mutate(suggest.id)}
      deciding={decide.isPending ? decide.variables.proposal.id : null}
    />
  );

  // A phone shows the editor alone, with the way back to the list
  if (phone && editing && !naming)
    return (
      <div className="resources-page is-phone is-editing">
        <button type="button" className="btn btn-quiet resources-back" onClick={() => (draft ? setDraft(null) : go(closeEditor))}>
          <ChevronLeft {...ICON_SM} />
          {t('resourcesAi.back')}
        </button>
        {editor}
        {createDialog}
      </div>
    );

  return (
    <div className={`resources-page ${phone ? 'is-phone' : ''}`.trim()}>
      <div className="resources-toolbar">
        {sectionControl}
        {!phone && otherMenu}
        {!phone && <span className="mono small muted grow resources-where">{t('resourcesAi.inProject')}</span>}
        {aiActions}
        <div className="resources-toolbar-end">
          {phone && otherMenu}
          {newButton}
        </div>
      </div>
      <ErrorBox error={listsError} />

      {editing && !phone ? (
        <section className="card resources-editor">
          {master}
          <div className="resources-detail">{editor}</div>
        </section>
      ) : (
        <div className={`resources-overview ${showCard ? 'has-card' : ''}`.trim()}>
          {card}
          <section className="card resources-list" aria-label={t('resourcesAi.inProjectTitle')}>
            <div className="resources-list-head">
              <h2>{t('resourcesAi.inProjectTitle')}</h2>
              <span className="mono small muted">{t('resourcesAi.inProjectCount', { count: kinds.reduce((sum, kind) => sum + count(kind), 0) })}</span>
            </div>
            {phone && naming ? master : (
              <InProjectList
                kinds={kinds}
                resources={resources}
                loading={listsLoading}
                current={null}
                teamMembers={teamMembers}
                teamTo={`/?project=${encodeURIComponent(project.id)}&view=team`}
                onOpen={(kind, name) => go({ res: `${kind}:${name}`, proposal: null, scope: null })}
              />
            )}
          </section>
        </div>
      )}
      {createDialog}
    </div>
  );
}
