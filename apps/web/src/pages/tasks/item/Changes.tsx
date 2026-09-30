import type { ChangedFile, WorkItemDetail } from '@agentry/shared';
import { GitBranch, GitCompareArrows } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useProjects, useWorkItemChanges } from '../../../api';
import { ICON_SM } from '@agentry/ui/components/icons';
import { ErrorBox, Loading } from '@agentry/ui/components/ui';
import { reviewLink, reviewPath } from '../../../lib/changes-summary';
import { totalsOf } from '../../../lib/observe';
import { diffstat, pathParts } from './model';
import { PullRequestRow } from './PullRequest';

/** The worktree as the project sees it (`.claude/worktrees/task-agn-2`), where it lies inside it. */
const relativeTo = (path: string, root: string | undefined): string => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

/** Five dots, sized by how much changed and split between added and removed. No status colours. */
function Diffstat({ file }: { file: Pick<ChangedFile, 'additions' | 'deletions'> }) {
  return (
    <span className="diffstat" aria-hidden>
      {diffstat(file).map((dot, i) => (
        <i key={i} className={dot === 'none' ? undefined : dot} />
      ))}
    </span>
  );
}

/** `+142 −0`, with the sentence a screen reader hears instead of the signs. */
function Counts({ file }: { file: Pick<ChangedFile, 'additions' | 'deletions'> }) {
  const { t } = useTranslation('workItem');
  return (
    <span className="diff-file-n">
      <span aria-hidden>
        +{file.additions} −{file.deletions}
      </span>
      <span className="sr-only">{t('changes.counts', { additions: file.additions, deletions: file.deletions })}</span>
    </span>
  );
}

/**
 * What changed in the item's own worktree: its branch against where it started and the files with a
 * diffstat. The diff itself is the review screen's, as a chat's and a task's are (design system §5):
 * each file opens there, and nothing links to an editor. Nothing is merged on its own (decision 20):
 * the person's approval opens the item's pull request, whose row closes the section.
 */
export function Changes({ item, compact = false, active = true }: { item: WorkItemDetail; compact?: boolean; active?: boolean }) {
  const { t } = useTranslation('workItem');
  const changes = useWorkItemChanges(item.id, active);
  const projects = useProjects(false);
  const project = projects.data?.find((p) => p.id === item.projectId);
  const summary = changes.data?.summary ?? null;
  const files = summary ? [...summary.files, ...summary.uncommitted.filter((u) => !summary.files.some((f) => f.path === u.path))] : [];
  const totals = totalsOf(files);
  const review = reviewPath.workItem(item.key);

  let body;
  if (changes.isLoading) body = <Loading />;
  else if (changes.error) body = <ErrorBox error={changes.error} />;
  else if (!summary) body = <p className="muted small workitem-none">{t('changes.none')}</p>;
  else
    body = (
      <>
        <div className="workitem-card changes">
          <div className="changes-head">
            <GitBranch {...ICON_SM} />
            <span className="mono small">{summary.branch ?? changes.data?.branch ?? t('changes.detached')}</span>
            <span className="mono small muted grow">{summary.base ? t('changes.from', { base: summary.base.slice(0, 8) }) : ''}</span>
            {files.length > 0 && <Counts file={totals} />}
          </div>
          {files.length === 0 ? (
            <p className="muted small changes-empty">{t('changes.nothingYet')}</p>
          ) : (
            files.map((file) => {
              const { dirs, name } = pathParts(file.path);
              return (
                <Link key={file.path} to={reviewLink(review, { file: file.path })} className="diff-file">
                  {/* Cut at its slashes, so a narrow column wraps there and keeps the file name whole */}
                  <span className="diff-file-path">
                    {dirs.map((dir, i) => (
                      <span key={i}>
                        {dir}
                        <wbr />
                      </span>
                    ))}
                    <span className="nowrap">{name}</span>
                  </span>
                  <span className="diff-file-facts">
                    <Counts file={file} />
                    <Diffstat file={file} />
                  </span>
                </Link>
              );
            })
          )}
        </div>
        {compact && changes.data?.worktree && (
          <p className="small muted changes-note">
            {t('changes.note')} <span className="mono">{relativeTo(changes.data.worktree, project?.path)}</span>
          </p>
        )}
        {files.length > 0 && (
          <div className="changes-actions">
            <Link to={review} className={`btn ${compact ? '' : 'btn-small'} grow`.trim()}>
              <GitCompareArrows {...ICON_SM} />
              {t('changes.viewDiff')}
            </Link>
          </div>
        )}
      </>
    );

  return (
    <section className="workitem-section" aria-labelledby={`changes-${item.id}`}>
      {!compact && (
        <div className="workitem-section-head">
          <h2 id={`changes-${item.id}`} className="section-label grow">
            {t('changes.title')}
          </h2>
        </div>
      )}
      {compact && (
        <h2 id={`changes-${item.id}`} className="sr-only">
          {t('changes.title')}
        </h2>
      )}
      {body}
      <PullRequestRow pr={item.pullRequest} />
    </section>
  );
}
