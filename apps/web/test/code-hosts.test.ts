import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, CodeHostStatus, OrchestrationPullRequest } from '@agentry/shared';
import { changeRequestRef, changeRequestWords } from '../src/lib/code-hosts';
import { targetsFor } from '../src/lib/events';

test('GitHub says PR with a hash and GitLab says MR with a bang', () => {
  assert.deepEqual(changeRequestWords('github'), { nounKey: 'pr.noun.pr', prefix: '#', label: 'GitHub' });
  assert.deepEqual(changeRequestWords('gitlab'), { nounKey: 'pr.noun.mr', prefix: '!', label: 'GitLab' });
});

test('a host that is not known reads as GitHub, as every project did before hosts', () => {
  assert.equal(changeRequestWords(null).label, 'GitHub');
  assert.equal(changeRequestWords(undefined).prefix, '#');
  assert.equal(changeRequestWords('bitbucket').nounKey, 'pr.noun.pr');
});

test('a number is written as its host writes it, and the server\'s own ref wins', () => {
  assert.equal(changeRequestRef('gitlab', 7), '!7');
  assert.equal(changeRequestRef('github', 12), '#12');
  assert.equal(changeRequestRef('gitlab', 7, '!7'), '!7');
  assert.equal(changeRequestRef('github', null), null);
});

test('the host events make the host and orchestration queries stale', () => {
  const base = { id: 1, at: '2026-10-01T00:00:00.000Z' };
  const hosts = { ...base, type: 'hosts.changed', hosts: [] as CodeHostStatus[] } as unknown as AgentryEvent;
  const keys = targetsFor(hosts).map(([key]) => key[0]);
  assert.ok(keys.includes('hosts'));
  assert.ok(keys.includes('project-code-host'));

  const pr = { ...base, type: 'orchestration.pull-request', orchestrationId: 'o1', pullRequest: {} as OrchestrationPullRequest } as unknown as AgentryEvent;
  const targets = targetsFor(pr).map(([key]) => key.join('/'));
  assert.ok(targets.includes('orchestration/o1'));
});
