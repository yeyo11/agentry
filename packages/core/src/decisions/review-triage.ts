import type { ChangeRequestThreads, ReviewThread } from '@agentry/shared';
import { stanceOf, type DecisionAsker } from './stance.ts';

/*
 * `review.triage` (docs/plans/code-hosts.md, phase 3): when a change request's threads are read, the
 * point is asked who should take each unresolved one, and the answer is kept in the decision history
 * under the change request's id. The Address dialog reads it from there, so its first selection is the
 * threads marked `agent`. It is a suggest point: nothing is replied, resolved or started by an answer.
 */

/** As many threads as an address hands over */
export const TRIAGE_THREADS_MAX = 40;
/** Each thread's text is cut to 1 KiB: a comment is a stranger's words and only data for the question */
const BODY_BYTES = 1024;

export interface ReviewTriageDeps {
  decisions: DecisionAsker;
}

/** The start of a text that fits `bytes` */
function startOf(text: string, bytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  return buf.length <= bytes ? text : buf.subarray(0, bytes).toString('utf8').replace(/�+$/, '');
}

function threadState(thread: ReviewThread): Record<string, unknown> {
  const body = thread.comments.map((c) => `${c.author ?? 'unknown'}: ${c.body}`).join('\n\n');
  return { id: thread.id, path: thread.path, body: startOf(body, BODY_BYTES), author: thread.comments[0]?.author ?? null, outdated: thread.isOutdated };
}

export class ReviewTriage {
  /** `<change request id>:<thread ids>` already asked in this process: the point is asked once per set of open threads */
  private readonly asked = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: ReviewTriageDeps) {}

  /** Called with every read of a change request's threads; asks in the background and never throws */
  onThreads(crId: string, projectId: string | null, title: string, list: ChangeRequestThreads): void {
    const open = list.threads.filter((t) => !t.isResolved).slice(0, TRIAGE_THREADS_MAX);
    if (!open.length) return;
    if (stanceOf(this.deps.decisions, 'review.triage', projectId) === 'off') return;
    const key = `${crId}:${open.map((t) => t.id).join(',')}`;
    if (this.asked.has(key)) return;
    this.asked.add(key);
    const run = this.deps.decisions
      .ask('review.triage', { kind: 'work_item', id: crId, data: { title, threads: open.map(threadState) } }, { projectId })
      .catch(() => undefined);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  /** Resolves when every question under way has been answered; for tests and a clean shutdown */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
