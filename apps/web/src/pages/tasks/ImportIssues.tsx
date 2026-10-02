import type { Project, ProjectTrackerSettings, TrackerIssue, TrackerIssuesPage } from '@agentry/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, Check, ChevronDown, Download, Link2, Lock, Search, Wand2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Checkbox, Sheet } from '@agentry/ui/components/controls';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Monogram } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { ErrorBox } from '@agentry/ui/components/ui';
import { timeAgo } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { WorkItemKey } from '../../components/work-item-icons';
import { importKeys, isSelectable, isTrackerBuilt, issueRef, toggleAll, toggleKey, trackerWords, TRIAGE_TONE } from '../../lib/trackers';

const BADGE = { size: 11, strokeWidth: 2, 'aria-hidden': true } as const;

/** The project's tracker, or null when it has none; a read that fails reads as none, the way the board does. */
export function useProjectTracker(projectId: string | null | undefined) {
  return useQuery({
    queryKey: keys.projectTracker(projectId ?? ''),
    queryFn: ({ signal }) => api.projectTracker(projectId ?? '', { signal }),
    enabled: !!projectId,
    retry: false,
    staleTime: 30_000,
  });
}

/** Import is offered where the project has a tracker with an adapter; Jira and YouTrack have none yet. */
export const canImportFrom = (tracker: ProjectTrackerSettings | null | undefined): tracker is ProjectTrackerSettings => !!tracker && isTrackerBuilt(tracker.id);

/** What the search field starts with: the project's own query, or the tracker's way of saying "open issues". */
export const startingQuery = (tracker: Pick<ProjectTrackerSettings, 'id' | 'query'>): string => tracker.query || (tracker.id === 'github-issues' ? 'is:open' : '');

/**
 * "Import issues" on the Tasks header. A neutral button: it takes the gradient only when it leads,
 * which is when the board is empty and this is how the project fills it.
 */
export function ImportIssuesButton({ leads, icon = false, onClick }: { leads: boolean; icon?: boolean; onClick: () => void }) {
  const { t } = useTranslation('issues');
  if (icon)
    return (
      <button type="button" className="icon-btn workitem-import-icon" aria-label={t('import.button')} title={t('import.button')} onClick={onClick}>
        <Download {...ICON_SM} />
      </button>
    );
  return (
    <button type="button" className={`btn ${leads ? 'btn-primary' : ''} workitem-import`.replace(/\s+/g, ' ').trim()} onClick={onClick}>
      <Download {...ICON_SM} />
      {t('import.button')}
    </button>
  );
}

function IssueRow({ issue, on, narrow, selecting, onToggle }: { issue: TrackerIssue; on: boolean; narrow: boolean; selecting: boolean; onToggle: () => void }) {
  const { t } = useTranslation('issues');
  const ref = issueRef(issue.tracker, issue.key);
  const pickable = isSelectable(issue);
  const mark = issue.triage;
  const head = (
    <span className="addr-head">
      {issue.type === 'bug' && <Bug {...ICON_SM} className="wi-type" role="img" aria-label={t('import.bug')} />}
      <span className="iss-key">{ref}</span>
      {mark && (
        <span className={`badge ${TRIAGE_TONE[mark] === 'ok' ? 'b-accent' : TRIAGE_TONE[mark] === 'warn' ? 'badge-idle' : ''}`.trim()} title={t(`markTitle.${mark}`)}>
          {t(`mark.${mark}`)}
        </span>
      )}
      {!pickable && (
        <>
          <span className="badge">
            <Link2 {...BADGE} />
            {t('import.imported')}
          </span>
          {issue.importedItemId && <ItemKeyOf id={issue.importedItemId} />}
        </>
      )}
    </span>
  );
  // Issue text is a stranger's: it is only ever drawn as text
  const main = (
    <span className="addr-main">
      {head}
      <p className="iss-title">{issue.title}</p>
      <span className="addr-by iss-by">
        {issue.updatedAt && <span>{timeAgo(issue.updatedAt)}</span>}
        {issue.labels.map((label) => (
          <span key={label} className="workitem-tag">
            {label}
          </span>
        ))}
      </span>
    </span>
  );
  if (!pickable)
    return (
      <div className="addr-thread static imported">
        <span className="iss-gap" aria-hidden />
        {main}
      </div>
    );
  // A phone has no checkboxes: browsing is plain text, and selecting turns each row into a pressed button
  if (narrow && !selecting) return <div className="addr-thread static">{main}</div>;
  if (narrow)
    return (
      <button type="button" className={`addr-thread ${on ? 'on' : ''}`.trim()} aria-pressed={on} aria-label={t('import.choose', { ref })} onClick={onToggle}>
        {main}
        <span className={`addr-state ${on ? 'on' : ''}`.trim()}>
          {on && <Check {...ICON_SM} />}
          {on ? t('import.chosen') : t('import.choosePhone')}
        </span>
      </button>
    );
  return (
    <Checkbox className={`addr-thread ${on ? 'on' : ''}`.trim()} checked={on} onChange={onToggle} aria-label={t('import.choose', { ref })}>
      {main}
    </Checkbox>
  );
}

/** The key of the item an issue was imported as; the page's own item list is not read just for this. */
function ItemKeyOf({ id }: { id: string }) {
  const item = useQuery({ queryKey: keys.workItem(id), queryFn: ({ signal }) => api.workItem(id, { signal }), staleTime: 60_000, retry: false });
  return item.data ? <WorkItemKey value={item.data.key} boxed /> : null;
}

/** One page of the tracker's own query after another, as far as the person asked to go. */
function useIssuePages(projectId: string, query: string, pages: number) {
  const results = useQueries({
    queries: Array.from({ length: pages }, (_, index) => ({
      queryKey: keys.trackerIssues(projectId, query, index + 1),
      queryFn: ({ signal }: { signal: AbortSignal }): Promise<TrackerIssuesPage> => api.trackerIssues(projectId, { ...(query ? { query } : {}), page: index + 1 }, { signal }),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const loaded = results.flatMap((r) => (r.data ? [r.data] : []));
  const last = results[results.length - 1];
  return {
    issues: loaded.flatMap((page) => page.issues),
    hasMore: loaded.length === pages && (loaded[loaded.length - 1]?.hasMore ?? false),
    loading: results.some((r) => r.isLoading),
    error: results.find((r) => r.isError)?.error ?? null,
    refetch: () => void last?.refetch(),
  };
}

/**
 * What the import dialog says and does, apart from the shell it is drawn in: the tracker's own
 * query (prefilled from the project's), the results with `issue.triage`'s marks, and Import, the
 * one gradient action. A mark is advice: nothing is chosen because of one, except by "Choose the
 * ready ones". Already imported issues cannot be picked again. On a phone choosing is a mode.
 */
export function useImportForm(project: Project, tracker: ProjectTrackerSettings, onClose: () => void) {
  const { t } = useTranslation('issues');
  const narrow = useMediaQuery(NARROW);
  const qc = useQueryClient();
  const toast = useToast();
  const words = trackerWords(tracker.id);
  const status = useQuery({ queryKey: keys.trackers, queryFn: ({ signal }) => api.trackers({ signal }), staleTime: 30_000 }).data?.find((s) => s.id === tracker.id);

  const [draft, setDraft] = useState(() => startingQuery(tracker));
  const [query, setQuery] = useState(() => tracker.query);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const list = useIssuePages(project.id, query, pages);
  const marked = list.issues.some((issue) => issue.triage !== null);
  const picks = narrow && !selecting ? [] : importKeys(list.issues, selected);
  const pickable = list.issues.filter(isSelectable).length;

  const search = () => {
    setQuery(draft.trim());
    setPages(1);
    setSelected(new Set());
  };
  const run = useMutation({
    mutationFn: (issueKeys: string[]) => api.importTrackerIssues(project.id, { keys: issueKeys }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: keys.projectTracker(project.id) });
      void qc.invalidateQueries({ queryKey: keys.workItems });
      const skipped = result.skipped.length;
      toast.success(t('import.done', { count: result.imported.length }), skipped > 0 ? t('import.skipped', { count: skipped }) : undefined);
      onClose();
    },
    onError: (error) => toast.error(t('import.error'), error),
  });

  const title = t('import.title', { tracker: words.label });
  const sub = [words.label, tracker.scope, status?.version ? `${status.cli} ${status.version}` : null].filter(Boolean).join(' · ');
  const body: ReactNode = (
    <div className="form addr-form iss-form">
      <form
        className="iss-search"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <label className="field field-mono grow">
          <Search {...ICON_SM} />
          {tracker.scope && <span className="mono small muted iss-scope">{tracker.scope}</span>}
          <input className="mono" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t('import.search', { tracker: words.label })} />
        </label>
        <button type="submit" className="btn">
          {t('import.run')}
        </button>
      </form>
      <span className="form-hint small muted">{t(tracker.id === 'github-issues' || tracker.id === 'gitlab-issues' ? `import.hint.${tracker.id}` : 'import.hint.other')}</span>
      <div className="addr-group">
        <div className="addr-bar">
          <span className="section-label">{t('import.open', { count: list.issues.length })}</span>
          {marked && (
            <span className="decided-face" title={t('import.suggestedTitle')}>
              {t('import.suggested')}
            </span>
          )}
          <span className="grow" />
          {pickable > 0 && (!narrow || selecting) && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setSelected(toggleAll(list.issues, selected))}>
              {picks.length === pickable ? t('import.clear') : t('import.all')}
            </button>
          )}
          {marked && (!narrow || selecting) && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => setSelected(new Set(list.issues.filter((issue) => issue.triage === 'ready' && isSelectable(issue)).map((issue) => issue.key)))}
            >
              <Wand2 {...ICON_SM} />
              {t('import.onlyReady')}
            </button>
          )}
        </div>
        {list.error ? (
          <>
            <ErrorBox error={list.error} title={t('import.failed', { tracker: words.label })} />
            <button type="button" className="btn btn-small" onClick={list.refetch}>
              {t('import.retry')}
            </button>
          </>
        ) : list.loading && list.issues.length === 0 ? (
          <p className="muted small" role="status">
            <Spinner /> {t('import.loading')}
          </p>
        ) : list.issues.length === 0 ? (
          <p className="muted small">{t('import.none')}</p>
        ) : (
          <div className="addr-list">
            {list.issues.map((issue) => (
              <IssueRow key={issue.key} issue={issue} on={selected.has(issue.key)} narrow={narrow} selecting={selecting} onToggle={() => setSelected(toggleKey(selected, issue.key))} />
            ))}
          </div>
        )}
        {list.hasMore && (
          <button type="button" className="btn iss-more" disabled={list.loading} onClick={() => setPages(pages + 1)}>
            {t('import.more')}
            <ChevronDown {...ICON_SM} />
          </button>
        )}
      </div>
      {marked && <p className="muted small">{t('import.marksNote')}</p>}
      <div className="callout iss-untrusted">
        <Lock {...ICON_SM} />
        <p className="small">
          <b>{t('import.untrustedLead')}</b> {t('import.untrusted', { tracker: words.label })}
        </p>
      </div>
    </div>
  );
  const none = picks.length === 0;
  const footer = (
    <>
      <span className="small muted addr-count">{t('import.count', { n: picks.length, total: pickable })}</span>
      <span className="grow" />
      {narrow && (
        <button type="button" className="btn" aria-pressed={selecting} onClick={() => setSelecting(!selecting)}>
          {selecting ? t('import.selecting') : t('import.select')}
        </button>
      )}
      <button type="button" className="btn" onClick={onClose}>
        {t('import.cancel')}
      </button>
      <button type="button" className="btn btn-primary" data-autofocus disabled={none || run.isPending} onClick={() => run.mutate(picks)}>
        {none ? t('import.pick') : t('import.importN', { count: picks.length })}
      </button>
    </>
  );
  return { narrow, title, sub, words, body, footer };
}

/** The import dialog on a desktop, a bottom sheet on a phone. */
export function ImportIssues({ project, tracker, onClose }: { project: Project; tracker: ProjectTrackerSettings; onClose: () => void }) {
  const { narrow, title, sub, words, body, footer } = useImportForm(project, tracker, onClose);
  if (narrow)
    return (
      <Sheet open onOpenChange={(next) => !next && onClose()} side="bottom" title={title} description={sub} footer={<div className="addr-foot">{footer}</div>}>
        {body}
      </Sheet>
    );
  return (
    <Dialog
      title={
        <span className="iss-dialog-head">
          <Monogram name={words.label} size={24} project />
          <span className="iss-dialog-title">
            {title}
            <span className="mono small muted">{sub}</span>
          </span>
        </span>
      }
      onClose={onClose}
      width={700}
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
