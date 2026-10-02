import type { IssueTriageMark, TrackerId, TrackerIssue } from '@agentry/shared';
import type { Db } from '../db.ts';
import { stanceOf, type DecisionAsker } from './stance.ts';

/*
 * `issue.triage` (docs/plans/code-hosts.md, phase 5): when a page of a tracker's issues is listed for
 * import, the point is asked whether an agent can start on each one as written, and the answer is kept
 * in the decision history under the project. The import dialog and the imported cards read it as
 * marks. It is a suggest point: nothing is imported, moved or written to the tracker by an answer.
 */

/** As many issues as one page of the import list holds */
export const TRIAGE_ISSUES_MAX = 40;
/** Each body is cut to 2 KiB: an issue is a stranger's text and only data for the question */
const BODY_BYTES = 2048;
const MARKS: readonly IssueTriageMark[] = ['ready', 'needs-refining', 'not-for-agents'];
/** How many answers back the marks are read from: a page asked later overrides an earlier one */
const HISTORY_ROWS = 20;

export interface IssueTriageDeps {
  decisions: DecisionAsker;
  db: Pick<Db, 'listDecisions'>;
}

/** The start of a text that fits `bytes` */
function startOf(text: string, bytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  return buf.length <= bytes ? text : buf.subarray(0, bytes).toString('utf8').replace(/�+$/, '');
}

function issueState(issue: TrackerIssue): Record<string, unknown> {
  return { id: issue.key, title: issue.title, body: startOf(issue.body, BODY_BYTES), labels: issue.labels };
}

/** What the history keeps the answers under; each answer is keyed by the issue's key */
export const issueSubjectId = (projectId: string, tracker: TrackerId): string => `${projectId}:${tracker}`;

export class IssueTriage {
  /** `<subject>:<keys>` already asked in this process: a page is asked once */
  private readonly asked = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: IssueTriageDeps) {}

  /**
   * Called with every page of the import list; asks in the background and never throws. Issues
   * already imported are not asked about: they are on the board and the person started from them.
   */
  onIssues(projectId: string, tracker: TrackerId, issues: readonly TrackerIssue[]): void {
    const open = issues.filter((i) => i.importedItemId === null).slice(0, TRIAGE_ISSUES_MAX);
    if (!open.length) return;
    if (stanceOf(this.deps.decisions, 'issue.triage', projectId) === 'off') return;
    const subject = issueSubjectId(projectId, tracker);
    const key = `${subject}:${open.map((i) => i.key).join(',')}`;
    if (this.asked.has(key)) return;
    this.asked.add(key);
    const run = this.deps.decisions
      .ask('issue.triage', { kind: 'tracker_issue', id: subject, data: { tracker, issues: open.map(issueState) } }, { projectId })
      .catch(() => undefined);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  /** What the point last said about each key; a key it never answered about is absent */
  marksOf(projectId: string, tracker: TrackerId, keys: readonly string[]): Map<string, IssueTriageMark> {
    const marks = new Map<string, IssueTriageMark>();
    if (!keys.length) return marks;
    try {
      const page = this.deps.db.listDecisions({ point: 'issue.triage', subjectKind: 'tracker_issue', subjectId: issueSubjectId(projectId, tracker), status: 'answered', limit: HISTORY_ROWS });
      // Newest first: the first answer for a key is the one that stands
      for (const row of page.items) {
        for (const [key, answer] of Object.entries(row.answers ?? {})) {
          if (marks.has(key) || !keys.includes(key) || answer.kind !== 'choice') continue;
          const mark = MARKS.find((m) => m === answer.value);
          if (mark) marks.set(key, mark);
        }
      }
    } catch {
      // A history that cannot be read leaves the issues unmarked
    }
    return marks;
  }

  /** Resolves when every question under way has been answered; for tests and a clean shutdown */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
