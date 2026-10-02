import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HostCall, HostResult } from '../src/hosts/code-host.ts';
import { Db } from '../src/db.ts';
import { IssueTriage, TRIAGE_ISSUES_MAX } from '../src/decisions/issue-triage.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { TrackerImportService, type TrackerAccess } from '../src/trackers/import.ts';
import { WorkItemService } from '../src/work-items.ts';
import { choiceOf, decisionRig } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// `issue.triage` over the real engine and store, with a scripted provider, asked from the import
// list that the route serves, against what glab recorded.

const here = dirname(fileURLToPath(import.meta.url));
const recorded = (label: string): string => readFileSync(join(here, 'fixtures/recordings/glab/1.120.0', `${label}.out`), 'utf8');
const ok = (stdout: string): HostResult => ({ exitCode: 0, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 1 });

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const rig = decisionRig(db, config);
  const triage = new IssueTriage({ decisions: rig.engine, db });
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null) });
  const access: TrackerAccess = {
    host: 'gitlab',
    hostname: 'gitlab.com',
    repo: { host: 'gitlab.com', path: 'yeyo11/agentry', owner: 'yeyo11', name: 'agentry' },
    run: async (call: HostCall) => ok(call.args[1] === 'list' ? recorded('iss_list') : recorded('iss_view')),
  };
  const service = new TrackerImportService({
    items,
    project: (id) => (id === 'p1' ? { path: '/p', tracker: { id: 'gitlab-issues', scope: 'yeyo11/agentry', query: '', statusMap: {} } } : null),
    access: async () => access,
    triage,
  });
  return { rig, triage, service };
}

test('issue.triage off: listing asks nothing and marks nothing', async () => {
  const s = setup();
  s.rig.provider.script = () => ({});
  const page = await s.service.list('p1', null, 1);
  await s.triage.idle();
  assert.equal(s.rig.provider.calls.length, 0);
  assert.ok(page.issues.every((i) => i.triage === null));
});

test('listing a page asks issue.triage once, keeps each answer by issue key, and the next read carries the marks', async () => {
  const s = setup();
  await s.rig.configure('issue.triage', 'shadow');
  s.rig.provider.script = (request) => {
    const ids = ((request.state as { issues: Array<{ id: string }> }).issues ?? []).map((i) => i.id);
    return Object.fromEntries(ids.map((id, n) => [id, choiceOf(n === 0 ? 'ready' : 'needs-refining')]));
  };
  const first = await s.service.list('p1', null, 1);
  assert.ok(first.issues.length > 1);
  assert.ok(first.issues.every((i) => i.triage === null), 'the page does not wait for the question');
  await s.triage.idle();
  await s.service.list('p1', null, 1);
  await s.triage.idle();
  assert.equal(s.rig.provider.calls.length, 1, 'the same page is asked once');

  const rows = s.rig.rows('issue.triage');
  assert.ok(rows.length >= 1);
  assert.equal(rows[0]?.subjectId, 'p1:gitlab-issues');

  const again = await s.service.list('p1', null, 1);
  assert.equal(again.issues[0]?.triage, 'ready');
  assert.ok(again.issues.slice(1).every((i) => i.triage === 'needs-refining'));
});

test('issue.triage sends at most 40 issues, each body cut to 2 KiB, and never an imported one', async () => {
  const s = setup();
  s.rig.provider.script = () => ({});
  await s.rig.configure('issue.triage', 'shadow');
  const issue = (n: number, importedItemId: string | null) => ({
    tracker: 'gitlab-issues' as const, key: String(n), externalId: null, title: `Issue ${String(n)}`, body: 'x'.repeat(5000), state: 'opened', labels: ['bug'], type: null, url: null, updatedAt: null, importedItemId, triage: null,
  });
  const many = [issue(0, 'item-1'), ...Array.from({ length: TRIAGE_ISSUES_MAX + 10 }, (_, i) => issue(i + 1, null))];
  s.triage.onIssues('p1', 'gitlab-issues', many);
  await s.triage.idle();
  const state = s.rig.provider.calls[0]?.state as { issues: Array<{ id: string; body: string }> };
  assert.equal(state.issues.length, TRIAGE_ISSUES_MAX);
  assert.ok(!state.issues.some((i) => i.id === '0'), 'an imported issue is not asked about');
  assert.ok(Buffer.byteLength(state.issues[0]?.body ?? '') <= 2048);
});

test('the point is declared as a project-scoped suggest point with the three marks as options', () => {
  const point = decisionPoint('issue.triage');
  assert.equal(point?.kind, 'suggest');
  assert.equal(point?.scope, 'project');
  const questions = point?.questions({ kind: 'tracker_issue', id: 'p1:gitlab-issues', data: { issues: [{ id: '7', title: 'Fix it' }] } }) ?? [];
  assert.equal(questions.length, 1);
  const first = questions[0];
  assert.ok(first?.kind === 'choice' && first.options.map((o) => o.id).join() === 'ready,needs-refining,not-for-agents');
});
