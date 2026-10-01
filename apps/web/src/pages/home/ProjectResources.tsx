import type { AssistantResourceKind, ConfigResource, ConfigScopeKind, Project } from '@agentry/shared';
import { ChevronLeft, Pencil, Plus, Sparkle } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Menu } from '@agentry/ui/components/controls/Menu';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { ErrorBox } from '@agentry/ui/components/ui';
import { useLeaveGuard } from '../../lib/dirty';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { NameForm, ResourceEditor, ResourcesTab } from '../config/ResourcesTab';
import { CreateWithAI } from './resources/CreateWithAI';
import { useResourcesData } from './resources/data';
import { AI_KINDS, isAiKind, sectionFrom } from './resources/model';
import { OtherKindsMenu, PendingProposalNav, SectionControl } from './resources/nav';
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
  const guard = useLeaveGuard();
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

  const { resources, listsLoading, listsError, count, suggest, runsById, kinds, cardProposals, pendingProposals, openProposal, detailsLoading, teamMembers, suggestRun, stopRun, decide, discardAll } =
    useResourcesData(project, scope, section, proposalId);

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
  const aiSection: 'all' | AssistantResourceKind = isAiKind(section) ? section : 'all';
  const sectionControl = <SectionControl section={aiSection} count={count} onChange={(next) => go({ section: next === 'all' ? null : next, ...closeEditor })} />;
  const otherMenu = <OtherKindsMenu section={section} phone={phone} onSelect={(kind) => go({ section: kind, ...closeEditor })} />;
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
  // The proposals show on the overview, which an open file hides: "Suggest" leaves the editor (asking
  // first if it holds unsaved text) so the run and what it proposes are in view
  const startSuggest = () =>
    void guard().then((ok) => {
      if (!ok) return;
      setDraft(null);
      setNaming(null);
      update(closeEditor);
      suggestRun.mutate();
    });
  const aiActions = (
    <div className="resources-ai-actions">
      <button type="button" className="btn resources-suggest" disabled={suggesting} aria-busy={suggesting || undefined} onClick={startSuggest}>
        {suggesting ? <Spinner className="resources-suggest-spin" /> : <Sparkle {...ICON_SM} />}
        {/* A phone's row holds two buttons and "+": the short label, as MobileRecursos draws it */}
        {suggesting ? t('resourcesAi.suggesting') : suggest && !phone ? t('resourcesAi.suggestAgain') : t('resourcesAi.suggest')}
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
    <PendingProposalNav proposals={pendingProposals} current={proposalId} onOpen={(proposal) => go({ proposal: proposal.id, res: null, scope: null })} />
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
