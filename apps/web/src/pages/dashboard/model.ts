/**
 * What the widgets compute from the API's answers, kept apart from React so it is unit tested:
 * which orchestration to show and how far it got, why a chat waits, which schedules come next,
 * how much is live in each project.
 */
import type {
  ChatSummary,
  Orchestration,
  OrchestrationTaskState,
  OrchestrationTaskStatus,
  PermissionRequest,
  Schedule,
} from '@agentry/shared';
import type { ProgressCounts, ProgressStatus, StepState } from '../../lib/progress';

/** What a chat stopped for, described so the component words it in the active language. */
export interface WaitingReason {
  kind: 'generic' | 'plan' | 'question' | 'tool';
  tool: string;
  /** Requests beyond the first one */
  more: number;
  detail: string | null;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function waitingFor(requests: readonly PermissionRequest[] | undefined): WaitingReason {
  const first = requests?.[0];
  if (!first) return { kind: 'generic', tool: '', more: 0, detail: null };
  const more = requests && requests.length > 1 ? requests.length - 1 : 0;
  const command = typeof first.input.command === 'string' ? first.input.command : null;
  const detail = clip(first.description ?? command ?? '', 140) || null;
  if (first.toolName === 'ExitPlanMode') return { kind: 'plan', tool: first.toolName, more, detail };
  if (first.toolName === 'AskUserQuestion' || first.requiresUserInteraction) return { kind: 'question', tool: first.toolName, more, detail };
  return { kind: 'tool', tool: first.toolName, more, detail };
}

/* An interrupted task goes on by itself once the wrapper is back, so it has not failed; a stopped
   one was someone's decision to give it up, which a bar says the way it says a skip. */
const TASK_PROGRESS: Record<OrchestrationTaskStatus, ProgressStatus> = {
  completed: 'done',
  running: 'running',
  failed: 'failed',
  pending: 'pending',
  blocked: 'pending',
  interrupted: 'pending',
  skipped: 'skipped',
  stopped: 'skipped',
};

export function taskCounts(tasks: readonly Pick<OrchestrationTaskState, 'status'>[]): ProgressCounts {
  const counts: ProgressCounts = {};
  for (const task of tasks) {
    const status = TASK_PROGRESS[task.status];
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export interface OrchestrationStage {
  /** Zero-based: stage 1 is the tasks that depend on nothing */
  index: number;
  tasks: OrchestrationTaskState[];
  state: StepState;
  done: number;
}

/**
 * The stages of a graph: a task sits one stage after the latest of the tasks it depends on. A
 * dependency on a task the graph does not have is ignored, and a cycle (which the server refuses,
 * but a stored graph is data) stops at the task that closes it instead of recursing for ever.
 */
export function orchestrationStages(orch: Pick<Orchestration, 'status' | 'tasks'>): OrchestrationStage[] {
  const byId = new Map(orch.tasks.map((task) => [task.id, task]));
  const levels = new Map<string, number>();
  const levelOf = (task: OrchestrationTaskState, path: Set<string>): number => {
    const known = levels.get(task.id);
    if (known !== undefined) return known;
    if (path.has(task.id)) return 0;
    path.add(task.id);
    let level = 0;
    for (const id of task.dependsOn ?? []) {
      const dep = byId.get(id);
      if (dep) level = Math.max(level, levelOf(dep, path) + 1);
    }
    path.delete(task.id);
    levels.set(task.id, level);
    return level;
  };
  const stages: OrchestrationTaskState[][] = [];
  for (const task of orch.tasks) {
    const level = levelOf(task, new Set());
    (stages[level] ??= []).push(task);
  }
  return stages
    .filter((tasks) => tasks !== undefined)
    .map((tasks, index) => {
      const done = tasks.filter((task) => task.status === 'completed' || task.status === 'skipped').length;
      return { index, tasks, done, state: stageState(tasks, orch.status) };
    });
}

function stageState(tasks: readonly OrchestrationTaskState[], status: Orchestration['status']): StepState {
  const has = (...statuses: OrchestrationTaskStatus[]) => tasks.some((task) => statuses.includes(task.status));
  if (has('running')) return 'current';
  // A failure the graph is holding for a person is a question to answer, not the end of it
  if (has('failed')) return status === 'waiting' ? 'waiting' : 'failed';
  if (tasks.every((task) => task.status === 'skipped' || task.status === 'stopped')) return 'skipped';
  if (tasks.every((task) => task.status === 'completed' || task.status === 'skipped' || task.status === 'stopped')) return 'done';
  if (has('blocked') && status === 'waiting') return 'waiting';
  return 'pending';
}

const newestFirst = (a: Orchestration, b: Orchestration) => b.createdAt.localeCompare(a.createdAt);

/** The running ones, newest first; when nothing runs, the latest one, so the widget says how it ended. */
export function orchestrationsToShow(list: readonly Orchestration[], limit: number): Orchestration[] {
  const live = list.filter((o) => o.status === 'running' || o.status === 'waiting').sort(newestFirst);
  if (live.length > 0) return live.slice(0, limit);
  const latest = [...list].sort(newestFirst)[0];
  return latest ? [latest] : [];
}

/** The directory a schedule starts its chat or orchestration in, when it names one. */
export function scheduleCwd(schedule: Pick<Schedule, 'target'>): string | undefined {
  return schedule.target.kind === 'chat' ? schedule.target.chat.cwd : schedule.target.spec.cwd;
}

/** Enabled schedules that will fire again, soonest first. */
export function upcomingSchedules(list: readonly Schedule[], include: (schedule: Schedule) => boolean, limit: number): Array<Schedule & { nextRunAt: string }> {
  return list
    .filter((s): s is Schedule & { nextRunAt: string } => s.enabled && s.nextRunAt !== null && include(s))
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
    .slice(0, limit);
}

export interface ProjectLive {
  working: number;
  waiting: number;
}

/** How many chats work or wait in each project, from the lists the page already has. */
export function liveByProject(chats: readonly Pick<ChatSummary, 'id' | 'project' | 'state'>[]): Map<string, ProjectLive> {
  const counts = new Map<string, ProjectLive>();
  const seen = new Set<string>();
  for (const chat of chats) {
    if (!chat.project || seen.has(chat.id)) continue;
    seen.add(chat.id);
    const entry = counts.get(chat.project.id) ?? { working: 0, waiting: 0 };
    if (chat.state === 'working') entry.working += 1;
    else if (chat.state === 'waiting') entry.waiting += 1;
    counts.set(chat.project.id, entry);
  }
  return counts;
}

/** The first lines of a Markdown document worth reading as an excerpt: no front matter, no blank runs. */
export function excerpt(markdown: string, lines = 6): string {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const kept: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(trimmed);
    if (kept.filter((l) => l !== '').length >= lines) break;
  }
  while (kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}
