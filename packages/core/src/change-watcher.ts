import type { EventBus } from './events.ts';
import { probeChanges } from './git.ts';
import type { Orchestrator } from './orchestrator.ts';

/**
 * How often a running worker's worktree is looked at, which is also the debounce: however many
 * times it saves a file in between, the clients hear once. A commit is news; a keystroke is not.
 */
export const CHANGES_INTERVAL_MS = 3000;

interface Watched {
  orchestrationId: string;
  orchestrationName: string;
  /** Null for the integration branch */
  taskId: string | null;
  label: string;
  branch: string;
  dir: string;
  base: string | null;
}

/**
 * Says when the work of a running orchestration task, or of the integration branch being built,
 * moved on disk. git has nothing to subscribe to, and a watch on a worktree would also fire for
 * every build artefact a worker produces, so it looks at a cheap fingerprint of each on a timer —
 * and only while a client is listening, since nobody else would hear it.
 */
export class ChangeWatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Everything watched at the last look, with what it looked like */
  private readonly seen = new Map<string, { fingerprint: string; watched: Watched }>();

  constructor(
    private readonly orchestrator: Pick<Orchestrator, 'list'>,
    private readonly bus: EventBus,
    private readonly intervalMs = CHANGES_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private targets(): Map<string, Watched> {
    const found = new Map<string, Watched>();
    for (const orch of this.orchestrator.list()) {
      const base = { orchestrationId: orch.id, orchestrationName: orch.name };
      for (const task of orch.tasks) {
        if (task.status !== 'running' || !task.worktree || !task.branch) continue;
        found.set(`${orch.id}/${task.id}`, { ...base, taskId: task.id, label: `Task ${task.name}`, branch: task.branch, dir: task.worktree, base: task.baseCommit ?? orch.baseCommit ?? null });
      }
      const integration = orch.integration;
      if (integration?.worktree && (integration.status === 'merging' || integration.status === 'resolving')) {
        found.set(`${orch.id}/integration`, { ...base, taskId: null, label: `Integration of ${orch.name}`, branch: integration.branch, dir: integration.worktree, base: orch.baseCommit ?? null });
      }
    }
    return found;
  }

  /**
   * One look at every worktree that is being worked in. What just stopped being watched gets a last
   * look too: the commit that ends a task usually lands in the same moment as its status changes.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.bus.subscribers === 0) return;
    this.ticking = true;
    try {
      const now = this.targets();
      const leaving = [...this.seen].filter(([key]) => !now.has(key)).map(([key, { watched }]) => [key, watched] as const);
      await Promise.all([...now, ...leaving].map(([key, watched]) => this.look(key, watched)));
      for (const [key] of leaving) this.seen.delete(key);
    } finally {
      this.ticking = false;
    }
  }

  private async look(key: string, watched: Watched): Promise<void> {
    let probe;
    try {
      probe = await probeChanges(watched.dir, watched.base);
    } catch {
      return; // not created yet, or already gone: the next look tries again
    }
    const before = this.seen.get(key);
    this.seen.set(key, { fingerprint: probe.fingerprint, watched });
    if (before ? before.fingerprint === probe.fingerprint : probe.ahead === 0 && probe.dirty === 0) return;
    this.bus.emit({
      type: 'changes.updated',
      title: `${watched.label}: ${probe.ahead} commit${probe.ahead === 1 ? '' : 's'}, ${probe.dirty} uncommitted file${probe.dirty === 1 ? '' : 's'}`,
      orchestrationId: watched.orchestrationId,
      orchestrationName: watched.orchestrationName,
      taskId: watched.taskId,
      branch: watched.branch,
      ahead: probe.ahead,
      uncommitted: probe.dirty,
    });
  }
}
