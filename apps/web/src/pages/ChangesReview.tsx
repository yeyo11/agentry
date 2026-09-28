import type { ChangedFile, ChangeSummary, EditStep } from '@agentry/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, Copy, Crosshair } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, keys, useOrchestration, useWorkItemByKey } from '../api';
import { Counts, FileMap, MapLegend, StatusLetter, useRowWords, type MapFile } from '../components/changes/FileMap';
import { FileReview } from '../components/changes/FileReview';
import { Fingerprint } from '../components/changes/Fingerprint';
import {
  filesOf,
  liveFile,
  neighbour,
  reviewKey,
  scopeOf,
  scopeParam,
  scopeQuery,
  splitPath,
  stableOrder,
  stepsFor,
  totalsOf,
  type ReviewScope,
} from '../components/changes/review-model';
import { LIVE_REFRESH_MS, type ReviewSource } from '../components/changes/source';
import { StepScrubber, StepsLens } from '../components/changes/steps/StepsLens';
import { currentStep } from '../components/changes/steps/steps-model';
import '../components/changes/changes.css';
import { Menu, MoreActions, Tooltip, type MenuEntry } from '../components/controls';
import { ICON_SM } from '../components/icons';
import { Spinner } from '../components/Spinner';
import { Empty, ErrorBox, Segmented, Skeleton, usePageTitle } from '../components/ui';
import { NARROW, useMediaQuery } from '../lib/media';
import {
  effectiveMode,
  isMode,
  isSeen,
  markSeen,
  readMode,
  readSeen,
  signatureOf,
  writeMode,
  writeSeen,
  type ReviewMode,
  type SeenMap,
} from '../lib/review-state';
import { useWidth } from '../lib/use-width';
import { isLive, taskPath } from '../lib/work-items';

// The review screen (docs/plans/changes-review.md): one page for a chat, a task and the integration
// branch. Each route builds a ReviewSource and draws the same screen, whose Result lens is the file
// map beside one file's diff. Deep links: `?file=`, `?mode=`, `?scope=`, `?lens=steps`, `?step=`.

/** Room the folded map and the block rail take beside the diff */
const BESIDE_DIFF = 48 + 14;

// ---------------------------------------------------------------------------------------------
// The three routes

export function ChatChangesReview() {
  const { id = '' } = useParams();
  const { t } = useTranslation('changes');
  // The chat itself, for its title, its directory and what it is running now
  const head = useQuery({
    queryKey: [...keys.chatScope(id), 'changes', 'head'],
    queryFn: () => api.chat(id, false, { limit: 1 }),
    refetchInterval: (q) => (q.state.data?.chat.execution ? LIVE_REFRESH_MS : false),
  });
  const chat = head.data?.chat;
  const live = Boolean(chat?.execution);
  const target = chat?.activity?.kind === 'tool' ? (chat.activity.target ?? null) : null;
  const source = useMemo<ReviewSource>(
    () => ({
      kind: 'chat',
      storageKey: `chat:${id}`,
      // Under the chat's key, beside the summary's own: this one keeps only the git half
      summary: (scope) => ({ queryKey: keys.chatChangesReview(id, scope), queryFn: () => api.chatChanges(id, scope).then((c) => c.summary) }),
      diff: (path, opts) => ({ queryKey: keys.chatDiff(id, path, opts), queryFn: () => api.chatDiff(id, path, opts) }),
      steps: { queryKey: keys.chatSteps(id), queryFn: () => api.chatSteps(id) },
      conversation: id,
      live,
      back: { to: `/chats/${encodeURIComponent(id)}`, label: t('back.chat') },
      subject: chat ? (chat.firstPrompt ?? chat.title) : null,
      activity: { target, cwd: chat?.cwd ?? null, top: chat?.worktree?.path ?? null },
    }),
    [id, live, target, chat?.firstPrompt, chat?.title, chat?.cwd, chat?.worktree?.path, t],
  );
  if (head.error) return <ErrorBox error={head.error} />;
  return <ReviewScreen source={source} />;
}

export function TaskChangesReview() {
  const { id = '', taskId = '' } = useParams();
  const { t } = useTranslation('changes');
  const orch = useOrchestration(id);
  const task = orch.data?.tasks.find((x) => x.id === taskId) ?? null;
  const live = task?.status === 'running';
  const target = task?.activity?.kind === 'tool' ? (task.activity.target ?? null) : null;
  const worktree = task?.worktree ?? null;
  const source = useMemo<ReviewSource>(
    () => ({
      kind: 'task',
      storageKey: `task:${id}:${taskId}`,
      summary: (scope) => ({ queryKey: keys.taskChanges(id, taskId, scope), queryFn: () => api.taskChanges(id, taskId, scope) }),
      diff: (path, opts) => ({ queryKey: keys.taskDiff(id, taskId, path, opts), queryFn: () => api.taskDiff(id, taskId, path, opts) }),
      steps: { queryKey: keys.taskSteps(id, taskId), queryFn: () => api.taskSteps(id, taskId) },
      // The worker's own chat holds the transcript its steps come from
      conversation: task?.sessionId ?? task?.runId ?? null,
      live,
      back: { to: `/orchestration/${encodeURIComponent(id)}?task=${encodeURIComponent(taskId)}`, label: t('back.task') },
      subject: task ? task.name || task.id : null,
      // A worker's directory is its worktree, which is also the top level its files are listed from
      activity: { target, cwd: worktree, top: worktree },
    }),
    [id, taskId, live, target, worktree, task?.name, task?.id, task?.sessionId, task?.runId, t],
  );
  if (orch.error) return <ErrorBox error={orch.error} />;
  if (orch.data && !task) return <Empty title={t('empty.scope')} />;
  return <ReviewScreen source={source} />;
}

export function IntegrationChangesReview() {
  const { id = '' } = useParams();
  const { t } = useTranslation('changes');
  const orch = useOrchestration(id);
  const status = orch.data?.integration?.status;
  const live = status === 'merging' || status === 'resolving';
  const source = useMemo<ReviewSource>(
    () => ({
      kind: 'integration',
      storageKey: `integration:${id}`,
      summary: (scope) => ({ queryKey: keys.integrationChanges(id, scope), queryFn: () => api.integrationChanges(id, scope) }),
      diff: (path, opts) => ({ queryKey: keys.integrationDiff(id, path, opts), queryFn: () => api.integrationDiff(id, path, opts) }),
      steps: null,
      conversation: null,
      live,
      back: { to: `/orchestration/${encodeURIComponent(id)}`, label: t('back.orchestration') },
      subject: orch.data?.name ?? null,
      activity: null,
    }),
    [id, live, orch.data?.name, t],
  );
  if (orch.error) return <ErrorBox error={orch.error} />;
  return <ReviewScreen source={source} />;
}

/**
 * A work item's own worktree and branch (`task/<key>`), which several chats may have worked in one
 * after another: no single transcript holds its steps, so it is reviewed by its result alone.
 */
export function WorkItemChangesReview() {
  const { key = '' } = useParams();
  const { t } = useTranslation('changes');
  const found = useWorkItemByKey(key);
  const item = found.data ?? null;
  const itemId = item?.id ?? '';
  const live = item ? isLive(item) : false;
  const source = useMemo<ReviewSource>(
    () => ({
      kind: 'workItem',
      storageKey: `work-item:${itemId}`,
      summary: (scope) => ({ queryKey: keys.workItemChangesReview(itemId, scope), queryFn: () => api.workItemChanges(itemId, scope).then((c) => c.summary) }),
      diff: (path, opts) => ({ queryKey: keys.workItemDiff(itemId, path, opts), queryFn: () => api.workItemDiff(itemId, path, opts) }),
      steps: null,
      conversation: null,
      live,
      back: { to: taskPath(item?.key ?? key), label: t('back.workItem', { key: item?.key ?? key.toUpperCase() }) },
      subject: item?.title ?? null,
      activity: null,
    }),
    [itemId, live, item?.key, item?.title, key, t],
  );
  if (found.error) return <ErrorBox error={found.error} />;
  if (found.isPending) return <Skeleton rows={4} />;
  if (!item) return <Empty title={t('empty.workItem')} />;
  return <ReviewScreen source={source} />;
}

// ---------------------------------------------------------------------------------------------
// The screen

type Lens = 'result' | 'steps';

function ReviewScreen({ source }: { source: ReviewSource }) {
  const { t } = useTranslation('changes');
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const phone = useMediaQuery(NARROW);
  const scope = scopeOf(params.get('scope'));
  const refetchInterval = source.live ? LIVE_REFRESH_MS : false;
  usePageTitle(source.subject ? t('pageTitle', { name: source.subject }) : t('title'));

  const allQ = useQuery({ ...source.summary({}), refetchInterval });
  const scopedQ = useQuery({ ...source.summary(scopeQuery(scope)), enabled: scope.kind === 'commit', refetchInterval });
  const stepsDef = source.steps ?? { queryKey: ['changes-review', 'no-steps'], queryFn: async (): Promise<EditStep[]> => [] };
  const stepsQ = useQuery({ ...stepsDef, enabled: source.steps !== null, refetchInterval });
  const steps = source.steps ? (stepsQ.data ?? null) : null;

  const summary = allQ.data ?? null;
  const noWorktree = allQ.data === null;
  const lens: Lens = noWorktree || params.get('lens') === 'steps' ? 'steps' : 'result';

  // ---- where a link goes: the same screen with some parameters changed ----
  const hrefWith = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      return `${location.pathname}${qs ? `?${qs}` : ''}`;
    },
    [params, location.pathname],
  );
  const fileHref = useCallback((path: string) => hrefWith({ file: path, lens: null, step: null }), [hrefWith]);

  // ---- Step by step: the step a link asks for, or the latest ----
  const stepList = useMemo(() => steps ?? [], [steps]);
  const step = lens === 'steps' ? currentStep(stepList, params.get('step')) : null;
  const stepHref = useCallback((stepId: string) => hrefWith({ lens: 'steps', step: stepId }), [hrefWith]);

  // ---- the files of the scope, in an order that holds still under the pointer ----
  const files = useMemo(() => (summary ? filesOf(scope, summary, scopedQ.data ?? null) : []), [scope, summary, scopedQ.data]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const [pointerIn, setPointerIn] = useState(false);
  const held = useRef<string[] | null>(null);
  const order = useMemo(() => stableOrder(files.map((f) => f.path), pointerIn ? held.current : null), [files, pointerIn]);
  held.current = order;
  const ordered = useMemo(() => order.map((p) => byPath.get(p)).filter((f): f is ChangedFile => !!f), [order, byPath]);
  const uncommitted = useMemo(() => new Set(summary?.uncommitted.map((f) => f.path) ?? []), [summary]);

  // ---- seen, per browser ----
  const [seen, setSeen] = useState<SeenMap>(() => readSeen(source.storageKey));
  useEffect(() => setSeen(readSeen(source.storageKey)), [source.storageKey]);
  const updateSeen = useCallback(
    (change: (held: SeenMap) => SeenMap) =>
      setSeen((held) => {
        const next = change(held);
        if (next !== held) writeSeen(source.storageKey, next);
        return next;
      }),
    [source.storageKey],
  );
  const seenCount = ordered.filter((f) => isSeen(seen, f)).length;

  const livePath = source.live && source.activity ? liveFile(source.activity.target, source.activity, order) : null;

  // ---- the current file ----
  const asked = params.get('file');
  const currentFile = (asked ? byPath.get(asked) : undefined) ?? (phone ? null : (ordered[0] ?? null));
  const go = useCallback((path: string) => navigate(fileHref(path), { replace: !phone }), [navigate, fileHref, phone]);
  const prev = neighbour(ordered, currentFile, -1);
  const next = neighbour(ordered, currentFile, 1);

  // ---- mode: asked for in the link, else remembered; Side by side only where there is room ----
  const [stored, setStored] = useState<ReviewMode>(() => readMode());
  const askedMode = params.get('mode');
  const wanted: ReviewMode = isMode(askedMode) ? askedMode : stored;
  const [bodyRef, bodyWidth] = useWidth<HTMLDivElement>(0, 1400);
  const status = currentFile?.status ?? null;
  const room = bodyWidth - BESIDE_DIFF;
  const mode = effectiveMode(wanted, { width: room, phone, status });
  const modes: ReviewMode[] = effectiveMode('split', { width: room, phone, status }) === 'split' ? ['reading', 'unified', 'split'] : ['reading', 'unified'];
  const setMode = useCallback(
    (m: ReviewMode) => {
      writeMode(m);
      setStored(m);
      navigate(hrefWith({ mode: m }), { replace: true });
    },
    [navigate, hrefWith],
  );

  // ---- the map: filter and fold ----
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const [folded, setFolded] = useState(false);
  const mapFolded = folded || mode === 'split';

  // ---- keys of the screen: n/p files, m mode, [ the map, / filter (the file answers j/k/o/v) ----
  const keyed = useRef({ next, prev, go, mode, modes, setMode, mode_split: mode === 'split', lens });
  keyed.current = { next, prev, go, mode, modes, setMode, mode_split: mode === 'split', lens };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyed.current;
      if (k.lens !== 'result') return;
      const key = reviewKey(e);
      if (key === 'n' && k.next) k.go(k.next.path);
      else if (key === 'p' && k.prev) k.go(k.prev.path);
      else if (key === 'm') k.setMode(k.modes[(k.modes.indexOf(k.mode) + 1) % k.modes.length] ?? 'reading');
      else if (key === '[' && !k.mode_split) setFolded((f) => !f);
      else if (key === '/') {
        setFolded(false);
        requestAnimationFrame(() => filterRef.current?.focus());
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const mapFiles: MapFile[] = ordered
    .filter((f) => !filter.trim() || f.path.toLowerCase().includes(filter.trim().toLowerCase()))
    .map((f) => ({ file: f, uncommitted: uncommitted.has(f.path), seen: isSeen(seen, f), live: f.path === livePath }));

  const onSeen = (file: ChangedFile) => (on: boolean, hash: string | null, andNext: boolean) => {
    updateSeen((held) => markSeen(held, file, hash, on));
    if (on && andNext) {
      const after = neighbour(ordered, file, 1);
      if (after) go(after.path);
    }
  };
  const onHash = (file: ChangedFile) => (hash: string) =>
    updateSeen((held) => {
      const mark = held[file.path];
      if (!mark || mark.sig !== signatureOf(file) || mark.hash === hash) return held;
      // Seen before its diff was known: keep it and remember the diff; a different diff: unseen again
      return mark.hash === null ? markSeen(held, file, hash, true) : markSeen(held, file, null, false);
    });

  const refs = refsOf(scope, summary);

  // ---- the parts ----
  const head = (
    <ReviewHeader
      source={source}
      summary={summary}
      files={files}
      scope={scope}
      lens={lens}
      noWorktree={noWorktree}
      hrefWith={hrefWith}
      phone={phone}
      stepCount={steps ? steps.length : null}
      print={
        lens === 'result' ? (
          ordered.length > 0 ? (
            <Fingerprint files={ordered} current={currentFile?.path ?? null} seen={new Set(ordered.filter((f) => isSeen(seen, f)).map((f) => f.path))} to={fileHref} />
          ) : null
        ) : step && stepList.length > 1 ? (
          <div className="edit-scrub-row">
            <StepScrubber steps={stepList} currentId={step.id} onPick={(stepId) => navigate(stepHref(stepId), { replace: true })} />
            <span className="edit-scrub-keys">
              <kbd className="palette-kbd">←</kbd>
              <kbd className="palette-kbd">→</kbd>
              {t('steps.keys')}
            </span>
          </div>
        ) : null
      }
    />
  );

  let content: ReactNode;
  if (allQ.error) content = <div className="changes-pane-state"><ErrorBox error={allQ.error} /></div>;
  else if (allQ.isPending) content = <div className="changes-pane-state"><Skeleton rows={8} height={16} /></div>;
  else if (lens === 'steps')
    content = (
      <StepsLens
        steps={steps}
        loading={source.steps !== null && stepsQ.isPending}
        error={stepsQ.error}
        current={step}
        hrefOf={stepHref}
        conversation={source.conversation}
        resultHref={noWorktree ? null : fileHref}
        note={noWorktree ? t('lens.noWorktree') : null}
        phone={phone}
        live={source.live}
        back={noWorktree ? source.back : { to: hrefWith({ lens: null, step: null }), label: t('steps.back') }}
      />
    );
  else if (files.length === 0 && !(scope.kind === 'commit' && scopedQ.isPending))
    content = (
      <div className="changes-pane-state">
        {scope.kind === 'all' ? <Empty title={t('empty.nothing')}>{t('empty.nothingBody')}</Empty> : <Empty title={t('empty.scope')}>{t('empty.scopeBody')}</Empty>}
      </div>
    );
  else if (phone && !currentFile)
    content = <PhoneFiles files={mapFiles} to={fileHref} seenCount={seenCount} total={ordered.length} />;
  else
    content = (
      <div className="changes-body" ref={bodyRef}>
        {!phone && (
          <FileMap
            files={mapFiles}
            current={currentFile?.path ?? null}
            to={fileHref}
            filter={filter}
            onFilter={setFilter}
            filterRef={filterRef}
            folded={mapFolded}
            onFold={mode === 'split' ? undefined : () => setFolded((f) => !f)}
            seenCount={seenCount}
            total={ordered.length}
            onPointer={setPointerIn}
          />
        )}
        {currentFile ? (
          <FileReview
            key={`${scopeParam(scope) ?? ''}:${currentFile.path}`}
            source={source}
            file={currentFile}
            scope={scope}
            mode={mode}
            modes={modes}
            onMode={setMode}
            seen={isSeen(seen, currentFile)}
            onSeen={onSeen(currentFile)}
            onHash={onHash(currentFile)}
            steps={steps ? stepsFor(steps, currentFile.path) : null}
            stepHref={stepHref}
            phone={phone}
            nav={{
              prev,
              next,
              to: fileHref,
              go,
              toggleMap: mode === 'split' ? undefined : () => setFolded((f) => !f),
              focusFilter: () => {
                setFolded(false);
                requestAnimationFrame(() => filterRef.current?.focus());
              },
            }}
            back={phone ? hrefWith({ file: null }) : undefined}
            refs={refs}
          />
        ) : (
          <div className="changes-pane changes-pane-state">
            <Skeleton rows={6} height={14} />
          </div>
        )}
      </div>
    );

  // A file or a step on a phone is a screen of its own, with its own header
  const fileScreen = phone && (lens === 'result' ? currentFile !== null : step !== null && !stepsQ.error);
  return (
    <div className="changes-review" data-lens={lens}>
      {!fileScreen && head}
      {content}
    </div>
  );
}

/** The names over Side by side's two halves */
function refsOf(scope: ReviewScope, summary: ChangeSummary | null): { before?: string; after?: string } {
  if (scope.kind === 'commit') return { before: `${scope.sha.slice(0, 7)}^`, after: scope.sha.slice(0, 7) };
  if (scope.kind === 'uncommitted') return { before: 'HEAD', after: 'worktree' };
  return { before: summary?.base?.slice(0, 7), after: 'worktree' };
}

// ---------------------------------------------------------------------------------------------
// Header

function ReviewHeader({
  source,
  summary,
  files,
  scope,
  lens,
  noWorktree,
  hrefWith,
  phone,
  print,
  stepCount,
}: {
  source: ReviewSource;
  summary: ChangeSummary | null;
  files: ChangedFile[];
  scope: ReviewScope;
  lens: Lens;
  noWorktree: boolean;
  hrefWith: (changes: Record<string, string | null>) => string;
  phone: boolean;
  print: ReactNode;
  /** How many steps the source has, for Step by step's line under the title */
  stepCount: number | null;
}) {
  const { t } = useTranslation('changes');
  const navigate = useNavigate();
  const totals = totalsOf(files);
  const stepsLens = lens === 'steps';
  const metaParts = stepsLens
    ? stepCount
      ? [t('steps.count', { count: stepCount })]
      : []
    : summary
    ? [
        summary.branch ?? t('meta.detached'),
        ...(phone ? [] : summary.base ? [t('meta.from', { base: summary.base.slice(0, 7) })] : []),
        t('meta.commits', { count: summary.ahead }),
        ...(phone ? [] : [t('meta.files', { count: files.length })]),
      ]
    : [];
  const setScope = (next: ReviewScope) => navigate(hrefWith({ scope: scopeParam(next), lens: null, step: null }), { replace: true });
  const commits = summary?.commits ?? [];
  const scopeLabel =
    scope.kind === 'all'
      ? t('scope.all')
      : scope.kind === 'uncommitted'
        ? t('scope.uncommitted')
        : (commits.find((c) => c.hash.startsWith(scope.sha))?.subject ?? scope.sha.slice(0, 7));
  const scopeEntries: MenuEntry[] = summary
    ? [
        { id: 'all', label: t('scope.all'), checked: scope.kind === 'all', onSelect: () => setScope({ kind: 'all' }) },
        ...(commits.length
          ? [
              {
                id: 'commits',
                label: t('scope.commits'),
                items: commits.map((c) => ({
                  id: c.hash,
                  label: c.subject,
                  shortcut: c.hash.slice(0, 7),
                  checked: scope.kind === 'commit' && c.hash.startsWith(scope.sha),
                  onSelect: () => setScope({ kind: 'commit', sha: c.hash }),
                })),
              },
            ]
          : []),
        {
          id: 'uncommitted',
          label: t('scope.uncommitted'),
          checked: scope.kind === 'uncommitted',
          disabled: summary.uncommitted.length === 0,
          disabledReason: t('scope.none'),
          onSelect: () => setScope({ kind: 'uncommitted' }),
        },
      ]
    : [];
  const patch = usePatchCopy(source, files, scope);

  const lensSwitch = <LensSwitch lens={lens} noWorktree={noWorktree} hasSteps={source.steps !== null} hrefWith={hrefWith} />;
  const live = source.live && (
    <span className="changes-live">
      <Spinner />
      {t('live')}
    </span>
  );
  const back = (
    <Tooltip content={source.back.label}>
      <Link to={source.back.to} className="icon-btn" aria-label={source.back.label}>
        <ChevronLeft size={phone ? 20 : 16} strokeWidth={1.75} aria-hidden />
      </Link>
    </Tooltip>
  );

  if (phone)
    return (
      <header className="changes-head">
        <div className="changes-head-row">
          {back}
          <div className="changes-head-text">
            <h1 className="changes-title">{t('title')}</h1>
            {metaParts.length > 0 && <span className="changes-meta">{metaParts.join(' · ')}</span>}
          </div>
          {!noWorktree && summary && !stepsLens && (
            <MoreActions
              label={t('scope.label')}
              entries={[
                ...scopeEntries,
                { id: 'sep', separator: true },
                { id: 'copy', label: patch.state === 'copied' ? t('copied') : t('copyPatch'), icon: Copy, disabled: files.length === 0, onSelect: patch.run },
              ]}
            />
          )}
        </div>
        {source.steps !== null && lensSwitch}
        {lens === 'result' && summary && (
          <>
            <div className="changes-totals">
              <span>{t('meta.files', { count: files.length })}</span>
              <Counts additions={totals.additions} deletions={totals.deletions} />
              {live}
            </div>
            {print}
          </>
        )}
      </header>
    );

  return (
    <header className="changes-head">
      <div className="changes-head-row">
        {back}
        <div className="changes-head-text">
          {source.subject && (
            <span className="changes-subject" title={source.subject}>
              {source.subject}
            </span>
          )}
          <div className="changes-title-row">
            <h1 className="changes-title">{t('title')}</h1>
            {metaParts.length > 0 && <span className={`changes-meta${stepsLens ? ' is-sentence' : ''}`}>{metaParts.join(' · ')}</span>}
            {summary && !stepsLens && <Counts additions={totals.additions} deletions={totals.deletions} />}
            {live}
          </div>
        </div>
        {source.steps !== null && lensSwitch}
        {!noWorktree && summary && !stepsLens && (
          <Menu
            label={t('scope.label')}
            entries={scopeEntries}
            trigger={
              <button type="button" className="chip changes-scope" aria-label={`${t('scope.label')}: ${scopeLabel}`}>
                <Crosshair {...ICON_SM} />
                <span className="changes-scope-label">{scopeLabel}</span>
                <ChevronDown {...ICON_SM} />
              </button>
            }
          />
        )}
        {!noWorktree && summary && !stepsLens && (
          <Tooltip content={patch.state === 'copied' ? t('copied') : patch.state === 'failed' ? t('copyFailed') : t('copyPatch')}>
            <button type="button" className="icon-btn" aria-label={patch.state === 'copied' ? t('copied') : t('copyPatch')} disabled={files.length === 0} onClick={patch.run}>
              {patch.state === 'copied' ? <Check {...ICON_SM} /> : <Copy {...ICON_SM} />}
            </button>
          </Tooltip>
        )}
      </div>
      {print}
    </header>
  );
}

/** Copies the patch of every file in the scope, read the way the review reads each diff */
function usePatchCopy(source: ReviewSource, files: ChangedFile[], scope: ReviewScope) {
  const client = useQueryClient();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const run = () => {
    void (async () => {
      try {
        const diffs = await Promise.all(files.map((f) => client.fetchQuery(source.diff(f.path, scopeQuery(scope)))));
        await navigator.clipboard.writeText(diffs.map((d) => (d.diff.endsWith('\n') ? d.diff : `${d.diff}\n`)).join(''));
        setState('copied');
      } catch {
        setState('failed');
      }
      window.setTimeout(() => setState('idle'), 1500);
    })();
  };
  return { state, run };
}

function LensSwitch({ lens, noWorktree, hasSteps, hrefWith }: { lens: Lens; noWorktree: boolean; hasSteps: boolean; hrefWith: (changes: Record<string, string | null>) => string }) {
  const { t } = useTranslation('changes');
  const navigate = useNavigate();
  return (
    <Segmented<Lens>
      className="changes-lens"
      label={t('lens.label')}
      value={lens}
      options={[
        { value: 'result', label: t('lens.result'), disabled: noWorktree, title: noWorktree ? t('lens.noWorktree') : undefined },
        { value: 'steps', label: t('lens.steps'), disabled: !hasSteps },
      ]}
      onChange={(value) => navigate(hrefWith(value === 'steps' ? { lens: 'steps' } : { lens: null, step: null }), { replace: true })}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Phone: the files as cells, each opening a screen of its own

function PhoneFiles({ files, to, seenCount, total }: { files: MapFile[]; to: (path: string) => string; seenCount: number; total: number }) {
  const { t } = useTranslation('changes');
  const words = useRowWords();
  return (
    <div className="changes-cells">
      <div className="changes-cells-head">
        <span className="section-label">{t('map.title')}</span>
        <span className="changes-seen-of">{t('map.seenOf', { seen: seenCount, total })}</span>
      </div>
      <nav aria-label={t('map.label')}>
        {files.map((m) => {
          const { dir, name } = splitPath(m.file.path);
          return (
            <Link
              key={m.file.path}
              to={to(m.file.path)}
              className={`changes-cell${m.seen ? ' is-seen' : ''}${m.live ? ' is-live' : ''}`}
              aria-label={words(m)}
            >
              <StatusLetter file={m.file} />
              <span className="changes-cell-text">
                <span className="changes-cell-name">
                  <span className="changes-file-name">{name}</span>
                  {m.uncommitted && <span className="changes-dot" aria-hidden />}
                </span>
                {dir && <span className="changes-cell-dir">{dir}</span>}
              </span>
              <span className="changes-file-end" aria-hidden>
                {m.seen && <Check size={16} strokeWidth={2.2} />}
                {m.live && <Spinner />}
                <Counts additions={m.file.additions} deletions={m.file.deletions} binary={m.file.binary} />
              </span>
            </Link>
          );
        })}
      </nav>
      <MapLegend keys={false} />
    </div>
  );
}
