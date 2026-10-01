import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolPolicy } from '@agentry/shared';
import { commandSegments, judge, runsGitPush } from '../src/policy-judge.ts';

const base: ToolPolicy = { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: 'any' }, network: 'omit', gitPush: 'deny' };
const withPolicy = (over: Partial<ToolPolicy>): ToolPolicy => ({ ...base, ...over });
const run = (policy: ToolPolicy, command: string) => judge(policy, { kind: 'command', command });

test('git push is denied in every form when the policy denies it', () => {
  for (const command of [
    'git push',
    'git push origin main',
    'git -C ../repo push',
    'git -c user.name=x --no-pager push --force',
    'git --git-dir=/a/.git push',
    'GIT_SSH_COMMAND=ssh git push',
    'cd x && git push',
    'ls; git  push origin',
    'echo hi | git push',
    'sudo -u root git push',
    '/usr/bin/git push',
    'bash -c "git push origin main"',
    "sh -c 'cd a && git -C b push'",
    '(git push)',
    'env FOO=1 git push',
  ]) assert.equal(run(base, command), 'deny', command);
});

test('git push is only judged when the policy says so, and verbs that merely contain the word pass', () => {
  assert.equal(run(withPolicy({ gitPush: 'omit' }), 'git push'), 'allow');
  for (const command of ['git status', 'git commit -m "push later"', 'git log --grep push', 'echo git push', 'git -C push status', 'git pull'])
    assert.equal(run(base, command), 'allow', command);
});

test('commandSegments cuts outside quotes only', () => {
  assert.deepEqual(commandSegments('a && b || c; d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(commandSegments('echo "a && b" && ls'), ['echo "a && b"', 'ls']);
  assert.equal(runsGitPush('echo "a; git push"'), false);
});

test('commands.allow none denies, any allows', () => {
  assert.equal(run(withPolicy({ commands: { allow: 'none' } }), 'ls'), 'deny');
  assert.equal(run(base, 'ls'), 'allow');
  assert.equal(judge(base, { kind: 'command' }), 'ask');
});

test('every CommandRule kind allows what it names and asks for the rest', () => {
  const policy = withPolicy({
    commands: { allow: [{ command: 'pwd', args: 'none' }, { command: 'ls', args: 'some' }, { command: 'git diff', args: 'prefix' }, { pattern: 'pnpm * test' }] },
  });
  assert.equal(run(policy, 'pwd'), 'allow');
  assert.equal(run(policy, 'pwd -P'), 'ask');
  assert.equal(run(policy, 'ls -la'), 'allow');
  assert.equal(run(policy, 'ls'), 'ask');
  assert.equal(run(policy, 'git diff'), 'allow');
  assert.equal(run(policy, 'git diff --stat'), 'allow');
  assert.equal(run(policy, 'git difftool'), 'ask');
  assert.equal(run(policy, 'pnpm --filter core test'), 'allow');
  assert.equal(run(policy, 'pnpm build'), 'ask');
  // One command off the list makes the whole line ask
  assert.equal(run(policy, 'pwd && rm -rf x'), 'ask');
  assert.equal(run(policy, 'pwd && ls -a'), 'allow');
});

test('commands.deny wins over an allow, for every rule kind', () => {
  const deny = withPolicy({ commands: { allow: 'any', deny: [{ command: 'rm', args: 'prefix' }, { command: 'curl', args: 'some' }, { command: 'id', args: 'none' }, { pattern: 'npm publish*' }] } });
  assert.equal(run(deny, 'rm -rf /'), 'deny');
  assert.equal(run(deny, 'curl http://x'), 'deny');
  assert.equal(run(deny, 'curl'), 'allow');
  assert.equal(run(deny, 'id'), 'deny');
  assert.equal(run(deny, 'npm publish --tag x'), 'deny');
  assert.equal(run(deny, 'ls && rm a'), 'deny');
  assert.equal(run(withPolicy({ commands: { allow: 'any', deny: 'all' } }), 'ls'), 'deny');
});

test('edits are judged by path against the allowed list', () => {
  const policy = withPolicy({ edit: { allow: ['docs', 'src/*.ts', 'notes/**'] } });
  const edit = (...paths: string[]) => judge(policy, { kind: 'edit', paths });
  assert.equal(edit('docs/a.md'), 'allow');
  assert.equal(edit('./docs/deep/a.md'), 'allow');
  assert.equal(edit('src/a.ts'), 'allow');
  assert.equal(edit('src/sub/a.ts'), 'deny');
  assert.equal(edit('notes/x/y.md'), 'allow');
  assert.equal(edit('docs/a.md', 'package.json'), 'deny');
  assert.equal(edit('docs/../package.json'), 'deny');
  assert.equal(edit('../outside.md'), 'deny');
  assert.equal(edit('/etc/passwd'), 'deny');
  assert.equal(edit('docsx/a.md'), 'deny');
  assert.equal(judge(policy, { kind: 'edit' }), 'ask');
  assert.equal(judge(withPolicy({ edit: { allow: 'none' } }), { kind: 'edit', paths: ['a'] }), 'deny');
  assert.equal(judge(withPolicy({ edit: { allow: 'any', deny: true } }), { kind: 'edit', paths: ['a'] }), 'deny');
  assert.equal(judge(base, { kind: 'edit', paths: ['a'] }), 'allow');
});

test('reads follow read.allow and denyPaths', () => {
  const policy = withPolicy({ read: { allow: true, denyPaths: ['.env', 'secrets/**'] } });
  assert.equal(judge(policy, { kind: 'read', paths: ['src/a.ts'] }), 'allow');
  assert.equal(judge(policy, { kind: 'read', paths: ['.env'] }), 'deny');
  assert.equal(judge(policy, { kind: 'read', paths: ['app/.env'] }), 'deny');
  assert.equal(judge(policy, { kind: 'read', paths: ['secrets/k/a'] }), 'deny');
  assert.equal(judge(withPolicy({ read: { allow: false } }), { kind: 'read', paths: ['a'] }), 'deny');
});

test('network, delegation and anything else', () => {
  const fetch = (network: ToolPolicy['network']) => judge(withPolicy({ network }), { kind: 'fetch', url: 'https://x' });
  assert.equal(fetch('allow'), 'allow');
  assert.equal(fetch('deny'), 'deny');
  assert.equal(fetch('omit'), 'ask');
  assert.equal(judge(withPolicy({ delegate: 'deny' }), { kind: 'delegate' }), 'deny');
  assert.equal(judge(base, { kind: 'delegate' }), 'ask');
  assert.equal(judge(base, { kind: 'other' }), 'ask');
});
