import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentryEvent, FlowCriterionResult, ProjectTrackerSettings, WorkItem } from '@agentry/shared';
import { Db } from '../../src/db.ts';
import { runHostCall } from '../../src/hosts/exec.ts';
import type { MergeService } from '../../src/hosts/merge-service.ts';
import { PullRequestService, type PullRequestDeps } from '../../src/pull-requests.ts';
import { itemWorktree } from '../../src/work-links.ts';
import { WorkItemService } from '../../src/work-items.ts';
import { tempConfig } from '../helpers.ts';

// What the golden tests of the pull request service stand on: a project with a bare repository
// beside it as `origin`, a fake `gh` or `glab` and a logging `git` first on the PATH, and the service built
// on them. Later tasks change how the service is built here, never the committed logs.

const FAKE_GH = fileURLToPath(new URL('./fake-gh.sh', import.meta.url));
const FAKE_GLAB = fileURLToPath(new URL('./fake-glab.sh', import.meta.url));
const GIT_SHIM = fileURLToPath(new URL('./git-shim.sh', import.meta.url));
export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'golden');

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const BASE_PATH = process.env.PATH ?? '';
process.env.AGENTRY_REAL_GIT = REAL_GIT;
// A developer's own settings would change what the service sets or removes, and so the logs
for (const name of ['GH_HOST', 'GH_REPO', 'NO_PROMPT', 'GIT_TERMINAL_PROMPT', 'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER']) delete process.env[name];

export type HostKind = 'github' | 'gitlab';

/** Where the project's `origin` claims to be: the bare repository has no host, and a host-less project is not ready. */
const ORIGIN_URL: Record<HostKind, string> = { github: 'https://github.com/acme/shop.git', gitlab: 'https://gitlab.com/acme/shop.git' };

/** The setup's own git: real, so that only the service's calls reach a log. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

export function write(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
}

export interface Repo {
  root: string;
  project: string;
  remote: string;
  /** Another clone, for what "GitHub" does to main meanwhile */
  other: string;
  state: string;
  /** What fake-glab answers from and writes to */
  glabState: string;
  bin: string;
  /** A PATH directory with the logging git and no gh */
  binNoGh: string;
  log: string;
}

export function repo(): Repo {
  // Resolved, so that the root is the same string in every path the service builds from it
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentry-golden-')));
  const remote = join(root, 'remote.git');
  const project = join(root, 'project');
  const other = join(root, 'other');
  const state = join(root, 'gh-state');
  const glabState = join(root, 'glab-state');
  const bin = join(root, 'bin');
  const binNoGh = join(root, 'bin-no-gh');
  mkdirSync(state);
  mkdirSync(glabState);
  mkdirSync(bin);
  mkdirSync(binNoGh);
  copyFileSync(FAKE_GH, join(bin, 'gh'));
  chmodSync(join(bin, 'gh'), 0o755);
  // fake-glab reads its recordings beside itself, so it is run where it is
  writeFileSync(join(bin, 'glab'), `#!/bin/sh\nexec '${FAKE_GLAB}' "$@"\n`);
  chmodSync(join(bin, 'glab'), 0o755);
  symlinkSync(GIT_SHIM, join(bin, 'git'));
  symlinkSync(GIT_SHIM, join(binNoGh, 'git'));
  execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', project]);
  sh(project, 'config', 'user.name', 'Test');
  sh(project, 'config', 'user.email', 'test@example.com');
  write(project, 'README.md', 'shop\n');
  write(project, 'cart.ts', 'export const total = 1;\n');
  sh(project, 'add', '-A');
  sh(project, 'commit', '-q', '-m', 'first');
  sh(project, 'remote', 'add', 'origin', remote);
  sh(project, 'push', '-q', '-u', 'origin', 'main');
  sh(project, 'remote', 'set-head', 'origin', 'main');
  execFileSync(REAL_GIT, ['clone', '-q', remote, other]);
  return { root, project, remote, other, state, glabState, bin, binNoGh, log: join(root, 'calls.log') };
}

/** A commit on the remote's main, as a PR merged on GitHub leaves it. */
export function landOnMain(r: Repo, file: string, content: string): void {
  sh(r.other, 'pull', '-q', 'origin', 'main');
  write(r.other, file, content);
  sh(r.other, 'add', '-A');
  sh(r.other, 'commit', '-q', '-m', `land ${file}`);
  sh(r.other, 'push', '-q', 'origin', 'main');
}

export function setup(opts: { r?: Repo; db?: Db; busy?: Set<string>; noGh?: boolean; host?: HostKind; verdicts?: FlowCriterionResult[]; merge?: MergeService; tracker?: ProjectTrackerSettings; onMerged?: PullRequestDeps['onMerged'] } = {}) {
  const r = opts.r ?? repo();
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = opts.db ?? new Db(config);
  const events: AgentryEvent[] = [];
  const services: PullRequestService[] = [];
  const items = new WorkItemService({
    db,
    project: (id) => (id === 'p1' ? { keyPrefix: 'CW', columnLimits: {} } : null),
    emit: (e) => {
      const event = { ...e, id: events.length + 1, at: new Date().toISOString() } as AgentryEvent;
      events.push(event);
      for (const s of services) s.observe(event);
    },
  });
  const busy = opts.busy ?? new Set<string>();
  // The service's synchronous git calls read the process's PATH, its asynchronous calls the one it is given
  process.env.PATH = `${r.bin}:${BASE_PATH}`;
  process.env.AGENTRY_ORIGIN_URL = ORIGIN_URL[opts.host ?? 'github'];
  const service = new PullRequestService({
    db,
    items,
    project: (id) => (id === 'p1' ? { path: r.project } : null),
    busy: (id) => busy.has(id),
    ...(opts.merge ? { merge: opts.merge } : {}),
    verdicts: () => opts.verdicts ?? [],
    ...(opts.onMerged ? { onMerged: opts.onMerged } : {}),
    ...(opts.tracker ? { projectTracker: () => opts.tracker ?? null } : {}),
    webOrigin: () => 'http://localhost:8787',
    env: { PATH: opts.noGh ? r.binNoGh : `${r.bin}:${BASE_PATH}`, FAKE_GH_STATE: r.state, FAKE_GLAB_STATE: r.glabState },
    searchPath: async () => (opts.noGh ? r.binNoGh : `${r.bin}:${BASE_PATH}`),
    // The fakes fail at once and the same way every time, so a read's retries must not wait
    // (a probe is never retried, as in the service's own runner)
    run: (call, where) =>
      runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env, retry: { sleep: async () => undefined, ...(call.class === 'probe' ? { delaysMs: [] } : {}) } }),
  });
  services.push(service);
  return { r, db, items, service, events, busy };
}

export type Setup = ReturnType<typeof setup>;

/** An item in review whose own worktree has one commit of work. */
export function reviewed(s: Setup): WorkItem {
  const item = s.items.create('p1', {
    title: 'Fix the cart total',
    description: 'The total was off by one.',
    type: 'task',
    acceptanceCriteria: [{ text: 'The total adds up' }, { text: 'A test covers it' }],
  });
  const place = itemWorktree(s.r.project, { ...item, projectId: 'p1' });
  assert.ok(place);
  s.items.setWorktree(item.id, { worktree: place.worktree, branch: place.branch });
  write(place.worktree, 'cart.ts', 'export const total = 2;\n');
  sh(place.worktree, 'add', '-A');
  sh(place.worktree, 'commit', '-q', '-m', 'fix the total');
  s.items.move(item.id, { status: 'in_review' });
  return s.items.find(item.id) ?? item;
}

/** What `gh pr view` answers from now on. */
export function view(r: Repo, state: 'OPEN' | 'MERGED' | 'CLOSED', rollup: unknown[] = [], n = 7): void {
  writeFileSync(
    join(r.state, 'view.json'),
    JSON.stringify({ state, mergedAt: state === 'MERGED' ? '2026-09-29T10:00:00Z' : null, statusCheckRollup: rollup, url: `https://github.com/acme/shop/pull/${n}` }),
  );
}

/** What `glab mr view` answers from now on. */
export function viewMr(r: Repo, state: 'opened' | 'merged' | 'closed', pipeline: string | null = null, n = 4): void {
  writeFileSync(
    join(r.glabState, 'view.json'),
    JSON.stringify({
      iid: n,
      web_url: `https://gitlab.com/acme/shop/-/merge_requests/${n}`,
      state,
      merged_at: state === 'merged' ? '2026-09-29T10:00:00.000Z' : null,
      head_pipeline: pipeline ? { id: 1, status: pipeline } : null,
    }),
  );
}

export async function opened(s: Setup, item: WorkItem): Promise<void> {
  const result = await s.service.approve(item.id);
  assert.equal(result.status, 202);
  await s.service.settled();
  assert.equal(s.items.find(item.id)?.pullRequest?.phase, 'open');
}

export const cleanup = (s: Setup): void => {
  delete process.env.AGENTRY_CALL_LOG;
  delete process.env.AGENTRY_ORIGIN_URL;
  process.env.PATH = BASE_PATH;
  rmSync(s.r.root, { recursive: true, force: true });
};

// ---------- the logs ----------

/** From here on, every call of the service to git and gh is written down. */
export function record(r: Repo): void {
  writeFileSync(r.log, '');
  process.env.AGENTRY_CALL_LOG = r.log;
}

/** A line of the log that says what happened between calls, so a reader can follow a scenario. */
export function note(r: Repo, text: string): void {
  appendFileSync(r.log, `# ${text}\n`);
}

/** Compares the calls written since `record` with `golden/<phase>/<name>.log`, or rewrites it under UPDATE_GOLDEN=1. */
export function expectGolden(r: Repo, phase: string, name: string): void {
  const actual = readFileSync(r.log, 'utf8').split(r.root).join('<root>').replace(/\b[0-9a-f]{40}\b/g, '<sha>');
  const file = join(GOLDEN_DIR, phase, `${name}.log`);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, 'utf8'), `${name}: the calls differ from ${file}`);
}
