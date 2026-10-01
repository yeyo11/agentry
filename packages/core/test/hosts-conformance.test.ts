import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HostParseError,
  type ChangeRequestView,
  type CodeHostAdapter,
  type HostCall,
  type HostRepo,
} from '../src/hosts/code-host.ts';
import { githubManifest } from '../src/hosts/github/manifest.ts';
import { gitlabManifest } from '../src/hosts/gitlab/manifest.ts';
import { checkConformance, EXPECTED_ENV, runConformance, type ConformanceOptions } from './hosts/conformance.ts';

// These tests run the suite on stub adapters, so that it is proved able to pass and to fail before
// the real adapters (c4, c5) are held to it. The stubs build the arguments the plan's matrix lists.

const classify = (call: HostCall): 'read' | 'write' => {
  const [group, verb] = call.args;
  return group === 'pr' || group === 'mr' ? (verb === 'create' ? 'write' : 'read') : 'read';
};

const ghRepo: HostRepo = { host: 'github.com', path: 'o/r', owner: 'o', name: 'r' };
const glRepo: HostRepo = { host: 'gitlab.com', path: 'grp/sub/proj', owner: 'grp/sub', name: 'proj', projectId: 77 };

const parseGhView = (stdout: string): ChangeRequestView => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new HostParseError('not JSON');
  }
  const o = value as { number?: number; url?: string; state?: string } | null;
  if (!o || typeof o !== 'object' || (o.state !== 'OPEN' && o.state !== 'MERGED' && o.state !== 'CLOSED')) {
    throw new HostParseError('no state');
  }
  const state = o.state === 'OPEN' ? 'open' : o.state === 'MERGED' ? 'merged' : 'closed';
  return { number: o.number ?? null, url: o.url ?? null, state, mergedAt: null, ci: 'none' };
};

const ghStub: CodeHostAdapter = {
  id: 'github',
  refPrefix: '#',
  env: () => ({ set: { ...EXPECTED_ENV.gh.set, NO_COLOR: '1' }, unset: EXPECTED_ENV.gh.unset }),
  version: () => ({ cli: 'gh', args: ['--version'], kind: 'read', class: 'probe', host: null }),
  parseVersion: (stdout) => /gh version (\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null,
  authStatus: () => ({ cli: 'gh', args: ['auth', 'status', '--json', 'hosts'], kind: 'read', class: 'probe', host: null }),
  parseAuth: (result, hostname) => {
    const parsed = JSON.parse(result.stdout) as { hosts: Record<string, Array<{ active: boolean; state: string; login: string }>> };
    const account = parsed.hosts[hostname]?.find((a) => a.active && a.state === 'success');
    return { signedIn: Boolean(account), user: account?.login ?? null };
  },
  defaultBranch: (repo) => ({
    cli: 'gh',
    args: ['api', '--hostname', repo.host, `repos/${repo.owner}/${repo.name}`],
    kind: 'read',
    class: 'read',
    host: repo.host,
    bucket: 'core',
  }),
  parseDefaultBranch: (stdout) => (JSON.parse(stdout) as { default_branch?: string }).default_branch ?? null,
  create: (repo, req) => ({
    cli: 'gh',
    args: ['pr', 'create', '-R', `${repo.host}/${repo.owner}/${repo.name}`, '--head', req.head, '--base', req.base, '--title', req.title, '--body-file', '-'],
    input: req.body,
    kind: 'write',
    class: 'write',
    host: repo.host,
  }),
  find: (repo, req) => ({
    cli: 'gh',
    args: ['pr', 'list', '-R', `${repo.host}/${repo.owner}/${repo.name}`, '--head', req.head, '--base', req.base, '--state', 'all', '--limit', '2', '--json', 'number,url,state,headRefName,baseRefName,isCrossRepository'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),
  parseFind: () => [],
  view: (repo, number) => ({
    cli: 'gh',
    args: ['pr', 'view', String(number), '-R', `${repo.host}/${repo.owner}/${repo.name}`, '--json', 'number,url,state,mergedAt,statusCheckRollup'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),
  parseView: parseGhView,
};

const glStub: CodeHostAdapter = {
  ...ghStub,
  id: 'gitlab',
  refPrefix: '!',
  env: () => ({ set: EXPECTED_ENV.glab.set, unset: EXPECTED_ENV.glab.unset }),
  version: () => ({ cli: 'glab', args: ['version'], kind: 'read', class: 'probe', host: null }),
  authStatus: (hostname) => ({ cli: 'glab', args: ['auth', 'status', '--hostname', hostname], kind: 'read', class: 'probe', host: hostname }),
  defaultBranch: (repo) => ({
    cli: 'glab',
    args: ['repo', 'view', '-R', `https://${repo.host}/${repo.path}`, '-F', 'json'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),
  create: (repo, req) => ({
    cli: 'glab',
    args: ['mr', 'create', '-R', `https://${repo.host}/${repo.path}`, '--source-branch', req.head, '--target-branch', req.base, '--title', req.title, '--description-file', '-', '--yes'],
    input: req.body,
    kind: 'write',
    class: 'write',
    host: repo.host,
  }),
  find: (repo, req) => ({
    cli: 'glab',
    args: ['mr', 'list', '-R', `https://${repo.host}/${repo.path}`, '-s', req.head, '-t', req.base, '-A', '-P', '2', '-F', 'json'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),
  view: (repo, number) => ({
    cli: 'glab',
    args: ['mr', 'view', String(number), '-R', `https://${repo.host}/${repo.path}`, '-F', 'json'],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),
};

const ghOptions: ConformanceOptions = {
  adapter: ghStub,
  manifest: githubManifest,
  repo: ghRepo,
  classify,
  recorded: {
    versions: [{ name: 'gh 2.92.0', stdout: 'gh version 2.92.0 (2026-04-28)\n', expect: '2.92.0' }],
    views: [
      { name: 'open', stdout: '{"number":4,"url":"https://github.com/o/r/pull/4","state":"OPEN"}', expect: { number: 4, url: 'https://github.com/o/r/pull/4', state: 'open', mergedAt: null, ci: 'none' } },
    ],
    // 2.92 answers this, exit 0, for a pull request that does not exist
    malformedViews: [{ name: 'invented number', stdout: '{"number":999999}' }],
    defaultBranches: [{ name: 'repo object', stdout: '{"default_branch":"main"}', expect: 'main' }],
    auth: [
      {
        name: 'signed in',
        hostname: 'github.com',
        result: { exitCode: 0, stdout: '{"hosts":{"github.com":[{"state":"success","active":true,"login":"someone"}]}}' },
        expect: { signedIn: true, user: 'someone' },
      },
    ],
  },
};

const glOptions: ConformanceOptions = { ...ghOptions, adapter: glStub, manifest: gitlabManifest, repo: glRepo, recorded: undefined };

// The suite, run for real on the stubs: this is what c4 and c5 do with their adapters.
runConformance(ghOptions);
runConformance(glOptions);

const violations = (options: ConformanceOptions): string[] => Object.values(checkConformance(options)).flat();
const broken = (patch: Partial<CodeHostAdapter>, base: ConformanceOptions = ghOptions): ConformanceOptions => ({
  ...base,
  adapter: { ...base.adapter, ...patch },
});

test('the suite passes the well-formed stubs', () => {
  assert.deepEqual(violations(ghOptions), []);
  assert.deepEqual(violations(glOptions), []);
});

test('the suite fails an adapter that does not pin its host', () => {
  const unpinned = broken({ defaultBranch: (repo) => ({ cli: 'gh', args: ['api', `repos/${repo.owner}/${repo.name}`], kind: 'read', class: 'read', host: repo.host }) });
  assert.match(violations(unpinned).join('\n'), /--hostname github\.com/);
  const noR = broken({ view: (repo, n) => ({ ...ghStub.view(repo, n), args: ['pr', 'view', String(n), '--json', 'number,state'] }) });
  assert.match(violations(noR).join('\n'), /must carry -R github\.com\/o\/r/);
});

test('the suite fails an absolute api URL, an api placeholder and a delete', () => {
  const url = broken({ defaultBranch: (repo) => ({ ...ghStub.defaultBranch(repo), args: ['api', '--hostname', repo.host, 'https://api.github.com/repos/o/r'] }) });
  assert.match(violations(url).join('\n'), /absolute URL/);
  const placeholder = broken({ defaultBranch: (repo) => ({ ...ghStub.defaultBranch(repo), args: ['api', '--hostname', repo.host, 'repos/{owner}/{repo}'] }) });
  assert.match(violations(placeholder).join('\n'), /placeholder/);
  const del = broken({ view: (repo, n) => ({ ...ghStub.view(repo, n), args: ['pr', 'delete', String(n), '-R', 'github.com/o/r'] }) });
  assert.match(violations(del).join('\n'), /delete/);
});

test('the suite fails a view that asks for number alone', () => {
  const lone = broken({ view: (repo, n) => ({ ...ghStub.view(repo, n), args: ['pr', 'view', String(n), '-R', 'github.com/o/r', '--json', 'number'] }) });
  assert.match(violations(lone).join('\n'), /at least two real fields/);
});

test('the suite fails a create that puts the body in argv or not on stdin', () => {
  const inArgv = broken({
    create: (repo, req) => ({ ...ghStub.create(repo, req), args: ['pr', 'create', '-R', 'github.com/o/r', '--body', req.body], input: undefined }),
  });
  const found = violations(inArgv).join('\n');
  assert.match(found, /as `input`/);
  assert.match(found, /body in argv|read the body from stdin/);
});

test('the suite fails an adapter whose kind disagrees with the classifier, or whose env is short', () => {
  const lying = broken({ create: (repo, req) => ({ ...ghStub.create(repo, req), kind: 'read' }) });
  assert.match(violations(lying).join('\n'), /classifier says write/);
  const env = broken({ env: () => ({ set: {}, unset: [] }) });
  const found = violations(env).join('\n');
  assert.match(found, /GH_TELEMETRY/);
  assert.match(found, /must remove GH_HOST/);
});

test('the suite fails a find that forgets the base, and a refPrefix that disagrees with the manifest', () => {
  const noBase = broken({ find: (repo, req) => ({ ...ghStub.find(repo, req), args: ghStub.find(repo, req).args.filter((w) => w !== req.base) }) });
  assert.match(violations(noBase).join('\n'), /base branch/);
  assert.match(violations(broken({ refPrefix: '!' })).join('\n'), /refPrefix ! ≠ manifest #/);
});

test('the suite fails a parser that accepts malformed output or maps a state wrongly', () => {
  const lenient = broken({ parseView: () => ({ number: null, url: null, state: 'open', mergedAt: null, ci: 'none' }) });
  assert.match(violations(lenient).join('\n'), /parseView accepted/);
  const wrong = broken({ parseView: (stdout) => ({ ...parseGhView(stdout), state: 'closed' }) });
  assert.match(violations(wrong).join('\n'), /parseView open/);
});
