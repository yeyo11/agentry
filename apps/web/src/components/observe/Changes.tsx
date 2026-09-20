import type { ChangedFile, ChangeSummary, ChatChanges, FileDiff, TouchedFile } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hunksOf, totalsOf } from '../../lib/observe';
import { joinPath } from '../../lib/editor';
import { formatDateTime, timeAgo } from '../../lib/format';
import { CodeBlock } from '../CodeBlock';
import { Dialog } from '../Dialog';
import { ErrorBox, Loading, Tag } from '../ui';
import { DiffCommandButton, EditorLink, OpenWorktree } from './EditorLinks';

/** Where a summary comes from and how one file of it is read: a task, the integration branch or a chat. */
export interface ChangeSource {
  /** Under the owner's own key, so the events that refresh the owner refresh this too */
  queryKey: readonly unknown[];
  diff: (path: string) => Promise<FileDiff>;
  /** Where the files are on disk, for links into the editor; null when the checkout is not known */
  dir: string | null;
  /** The main checkout, the other half of a side-by-side diff */
  compare: string | null;
  /** Something is still working, so the summary is read again on a slow timer besides the events */
  live: boolean;
}

const LIVE_REFRESH_MS = 8_000;

// ---------- one file's diff ----------

function DiffBody({ source, path }: { source: ChangeSource; path: string }) {
  const { t } = useTranslation('observe');
  const { data, error, isLoading } = useQuery({
    queryKey: [...source.queryKey, 'diff', path],
    queryFn: () => source.diff(path),
    refetchInterval: source.live ? LIVE_REFRESH_MS : false,
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data || !data.diff.trim()) return <p className="muted small">{t('changes.emptyDiff')}</p>;
  const hunks = hunksOf(data.diff);
  const { dir } = source;
  return (
    <div className="stack-tight obs-diff">
      {dir && hunks.length > 0 && (
        <ul className="obs-hunks" aria-label={t('changes.hunks')}>
          {hunks.map((hunk, i) => (
            <li key={i}>
              <span className="mono small">{t('changes.atLine', { line: hunk.line })}</span>
              <EditorLink dir={dir} file={path} line={hunk.line} label={t('editor.openAtLine', { path, line: hunk.line })} />
            </li>
          ))}
        </ul>
      )}
      <CodeBlock code={data.diff} lang="diff" />
    </div>
  );
}

// ---------- the lists of files ----------

const signed = (n: number, sign: '+' | '−') => `${sign}${n}`;

function Counts({ file }: { file: Pick<ChangedFile, 'additions' | 'deletions'> }) {
  const { t } = useTranslation('observe');
  return (
    <span className="obs-counts mono small">
      {/* The signs and the numbers say it; the screen reader gets it as a sentence */}
      <span className="sr-only">{t('changes.counts', { additions: file.additions, deletions: file.deletions })}</span>
      <span aria-hidden className="obs-add">
        {signed(file.additions, '+')}
      </span>{' '}
      <span aria-hidden className="obs-del">
        {signed(file.deletions, '−')}
      </span>
    </span>
  );
}

function FileList({
  label,
  files,
  source,
  inline,
  onOpen,
}: {
  label: string;
  files: ChangedFile[];
  source: ChangeSource;
  inline: boolean;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation('observe');
  const [open, setOpen] = useState<string | null>(null);
  if (files.length === 0) return null;
  return (
    <div className="stack-tight">
      <h4 className="obs-subhead">
        {label} <span className="count">{files.length}</span>
      </h4>
      <ul className="obs-files" aria-label={label}>
        {files.map((file) => {
          const expanded = inline && open === file.path;
          // A side-by-side diff needs the file on both sides: not for one that was added or deleted
          const comparable = file.status === 'modified' || file.status === 'renamed';
          return (
            <li key={file.path} className="obs-file">
              <div className="obs-file-row">
                <button
                  type="button"
                  className="obs-file-name mono"
                  aria-expanded={inline ? expanded : undefined}
                  aria-haspopup={inline ? undefined : 'dialog'}
                  onClick={() => (inline ? setOpen(expanded ? null : file.path) : onOpen(file.path))}
                >
                  {file.path}
                </button>
                <Tag>{t(`changes.status.${file.status}`)}</Tag>
                <Counts file={file} />
                {source.dir && file.status !== 'deleted' && <EditorLink dir={source.dir} file={file.path} label={t('editor.openFile', { path: file.path })} />}
                {source.dir && source.compare && comparable && (
                  <DiffCommandButton left={joinPath(source.compare, file.previousPath ?? file.path)} right={joinPath(source.dir, file.path)} />
                )}
              </div>
              {file.previousPath && <div className="small muted mono">{t('changes.renamedFrom', { path: file.previousPath })}</div>}
              {expanded && <DiffBody source={source} path={file.path} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- the summary ----------

export function SummaryView({ summary, source, inline }: { summary: ChangeSummary; source: ChangeSource; inline: boolean }) {
  const { t } = useTranslation('observe');
  const [drawer, setDrawer] = useState<string | null>(null);
  const totals = totalsOf(summary.files);
  const nothing = summary.commits.length === 0 && summary.files.length === 0 && summary.uncommitted.length === 0;
  return (
    <div className="stack obs-changes">
      <div className="meta">
        <span className="meta-icon">
          <GitBranch size={12} strokeWidth={1.75} aria-hidden />
          <span className="mono">{summary.branch ?? t('changes.detached')}</span>
        </span>
        {summary.base && <span>{t('changes.base', { base: summary.base.slice(0, 8) })}</span>}
        <span>{t('changes.ahead', { count: summary.ahead })}</span>
        {summary.files.length > 0 && (
          <span className="mono">
            <span className="obs-add">{signed(totals.additions, '+')}</span> <span className="obs-del">{signed(totals.deletions, '−')}</span>
          </span>
        )}
        {source.dir && <OpenWorktree dir={source.dir} />}
      </div>

      {nothing && <p className="muted small">{t('changes.nothing')}</p>}

      {summary.commits.length > 0 && (
        <div className="stack-tight">
          <h4 className="obs-subhead">
            {t('changes.commits')} <span className="count">{summary.commits.length}</span>
          </h4>
          <ol className="obs-commits" aria-label={t('changes.commits')}>
            {summary.commits.map((commit) => (
              <li key={commit.hash}>
                <GitCommitHorizontal size={12} strokeWidth={1.75} aria-hidden />
                <span className="mono small">{commit.hash.slice(0, 8)}</span>
                <span className="obs-commit-subject">{commit.subject}</span>
                <span className="small muted" title={formatDateTime(commit.at)}>
                  {commit.author} · {timeAgo(commit.at)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <FileList label={t('changes.files')} files={summary.files} source={source} inline={inline} onOpen={setDrawer} />
      <FileList label={t('changes.uncommitted')} files={summary.uncommitted} source={source} inline={inline} onOpen={setDrawer} />

      {drawer && (
        <Dialog variant="drawer" width={820} title={<span className="mono break">{drawer}</span>} onClose={() => setDrawer(null)}>
          <DiffBody source={source} path={drawer} />
        </Dialog>
      )}
    </div>
  );
}

/** What a task or the integration branch changed, live while it works. */
export function ChangesView({ source, load, inline }: { source: ChangeSource; load: () => Promise<ChangeSummary>; inline: boolean }) {
  const { data, error, isLoading } = useQuery({
    queryKey: source.queryKey,
    queryFn: load,
    refetchInterval: source.live ? LIVE_REFRESH_MS : false,
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return data ? <SummaryView summary={data} source={source} inline={inline} /> : null;
}

// ---------- a chat ----------

function TouchedList({ files }: { files: TouchedFile[] }) {
  const { t } = useTranslation('observe');
  if (files.length === 0) return <p className="muted small">{t('changes.nothingTouched')}</p>;
  return (
    <div className="stack-tight">
      <p className="small muted">{t('changes.touchedIntro')}</p>
      <ul className="obs-files" aria-label={t('changes.touched')}>
        {files.map((file) => (
          <li key={file.path} className="obs-file">
            <div className="obs-file-row">
              <span className="obs-file-name mono">{file.path}</span>
              <Tag>{file.tool}</Tag>
              <span className="small muted" title={formatDateTime(file.at)}>
                {timeAgo(file.at)}
              </span>
              {file.path.startsWith('/') && <EditorLink dir={file.path} label={t('editor.openFile', { path: file.path })} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A chat in a worktree gets the git summary; anywhere else, the files its own tool calls wrote. */
export function ChatChangesView({ source, load }: { source: ChangeSource; load: () => Promise<ChatChanges> }) {
  const { data, error, isLoading } = useQuery({
    queryKey: source.queryKey,
    queryFn: load,
    refetchInterval: source.live ? LIVE_REFRESH_MS : false,
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return data.summary ? <SummaryView summary={data.summary} source={source} inline={false} /> : <TouchedList files={data.touched} />;
}
