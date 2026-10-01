import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Check } from '@agentry/shared';
import {
  HostParseError,
  HostRequestError,
  type ChangeRequestView,
  type ChecksAdapter,
  type CodeHostAdapter,
  type HostCall,
  type HostRepo,
  type HostResult,
} from '../../src/hosts/code-host.ts';
import type { CodeHostManifest } from '../../src/hosts/manifest.ts';

/**
 * The conformance suite every code host adapter passes (docs/plans/code-hosts.md, "Fakes and tests,
 * for every phase"). It is grown by every phase: a new adapter call adds its checks here.
 *
 * It is two layers so that it can fail on purpose in its own tests: `checkConformance` returns the
 * violations of each rule as sentences, and `runConformance` registers one `node:test` test per
 * rule that asserts there are none.
 */

/** Adapter-independent expectations of the execution layer's environment table, per CLI. */
export const EXPECTED_ENV: Record<'gh' | 'glab', { set: Record<string, string>; unset: string[] }> = {
  gh: {
    set: {
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      GH_PAGER: 'cat',
      GH_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
    },
    unset: ['GH_HOST', 'GH_REPO', 'GH_FORCE_TTY', 'GH_DEBUG', 'DEBUG', 'CLICOLOR_FORCE'],
  },
  glab: {
    set: { GLAB_NO_PROMPT: '1', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false' },
    unset: ['NO_PROMPT', 'GITLAB_HOST', 'GL_HOST', 'GITLAB_URI', 'DEBUG', 'GLAB_DEBUG'],
  },
};

/** A recorded output and what the parser must read from it. */
export interface RecordedParse<T> {
  name: string;
  stdout: string;
  expect: T;
}

export interface RecordedOutputs {
  versions?: RecordedParse<string | null>[];
  /** Every state the host reports, and every CI state of the tables, mapped as the plan says */
  views?: RecordedParse<ChangeRequestView>[];
  /** Outputs `parseView` must throw `HostParseError` on, besides the generic malformed ones below */
  malformedViews?: Array<{ name: string; stdout: string }>;
  finds?: RecordedParse<ReturnType<CodeHostAdapter['parseFind']>>[];
  defaultBranches?: RecordedParse<string | null>[];
  /** Round one of a list read: what `parseChecks` must make of the outputs of `checks()` */
  checks?: Array<{
    name: string;
    ref: { headSha: string | null; pipelineId: number | null };
    results: string[];
    /** The fields named here are compared, in order; `next` is how many follow-up calls it asks for */
    expect: { checks: Array<Partial<Check>>; truncated: boolean; next: number };
  }>;
  /** Outputs `parseChecks` must refuse, one per call of `checks()` */
  malformedChecks?: Array<{ name: string; results: string[] }>;
  auth?: Array<{
    name: string;
    hostname: string;
    result: Partial<HostResult> & { stdout: string; exitCode: number | null };
    expect: { signedIn: boolean; user: string | null };
  }>;
}

export interface ConformanceOptions {
  /** The checks half is held to its rules only when the adapter has it */
  adapter: CodeHostAdapter & Partial<ChecksAdapter>;
  manifest: CodeHostManifest;
  /** A repository on `host`; GitLab's carries `projectId`, which its API calls are pinned on */
  repo: HostRepo;
  /** The classifier of `hosts/classify.ts`: what the execution layer treats a call as */
  classify: (call: HostCall) => 'read' | 'write';
  recorded?: RecordedOutputs;
}

/** A body with the characters a shell would trip on: it must still only travel on stdin. */
const BODY = 'Objective: ship it\n\n- "quoted" and `ticks` and $(subshell)\n- ends here\n';
const HEAD = 'task/ab12cd34';
const BASE = 'release/2026.10';
const TITLE = 'Open the branch & wait';

/** Output every parser must refuse, whatever the host: nothing here is a change request. */
const GENERIC_MALFORMED = ['', 'not json', '[]', 'null', '{}', '{"error":{"message":"failed to get merge request 1"}}'];

const CALL_CLASSES: ReadonlyArray<HostCall['class']> = ['probe', 'read', 'write', 'log', 'long-write'];

interface NamedCall {
  name: string;
  call: HostCall;
  /** Whether the call concerns the repository, so it must be pinned to it */
  scoped: boolean;
}

function calls(options: ConformanceOptions): NamedCall[] {
  return [...baseCalls(options), ...checksCalls(options)];
}

function baseCalls(options: ConformanceOptions): NamedCall[] {
  const { adapter, repo } = options;
  return [
    { name: 'version', call: adapter.version(), scoped: false },
    { name: 'authStatus', call: adapter.authStatus(repo.host), scoped: false },
    { name: 'defaultBranch', call: adapter.defaultBranch(repo), scoped: true },
    { name: 'create', call: adapter.create(repo, { head: HEAD, base: BASE, title: TITLE, body: BODY }), scoped: true },
    { name: 'find', call: adapter.find(repo, { head: HEAD, base: BASE }), scoped: true },
    { name: 'view', call: adapter.view(repo, 4242), scoped: true },
  ];
}

/** One of each kind of check, so every call an adapter can build for one is built. */
export const SAMPLE_CHECKS: Check[] = [
  { id: '1001', name: 'build', group: null, state: 'failed', allowedToFail: false, required: false, startedAt: null, finishedAt: null, url: 'https://example.com/acme/shop/actions/runs/555/job/1001', rerunnable: true, hasLog: true, source: 'actions' },
  { id: '1002', name: 'unit', group: null, state: 'running', allowedToFail: false, required: false, startedAt: null, finishedAt: null, url: 'https://example.com/acme/shop/actions/runs/555/job/1002', rerunnable: false, hasLog: true, source: 'actions' },
  { id: '1003', name: 'deploy', group: 'test', state: 'manual', allowedToFail: false, required: false, startedAt: null, finishedAt: null, url: null, rerunnable: false, hasLog: true, source: 'job' },
  { id: '1004', name: 'child', group: 'test', state: 'failed', allowedToFail: false, required: false, startedAt: null, finishedAt: null, url: null, rerunnable: true, hasLog: false, source: 'bridge' },
  { id: '1005', name: 'ci/other', group: null, state: 'passed', allowedToFail: false, required: false, startedAt: null, finishedAt: null, url: null, rerunnable: false, hasLog: false, source: 'status' },
];

function checksCalls(options: ConformanceOptions): NamedCall[] {
  const { adapter, repo } = options;
  if (!adapter.readChangeRequest || !adapter.checks || !adapter.jobLog || !adapter.annotations || !adapter.rerun || !adapter.cancel || !adapter.playManual || !adapter.required) return [];
  const named: NamedCall[] = [{ name: 'readChangeRequest', call: adapter.readChangeRequest(repo, 4242), scoped: true }];
  const add = (name: string, calls: HostCall[]): void => calls.forEach((call, at) => named.push({ name: `${name}[${String(at)}]`, call, scoped: true }));
  add('checks', adapter.checks(repo, { headSha: 'abc123def', pipelineId: 777 }));
  for (const check of SAMPLE_CHECKS) {
    for (const version of ['2.92.0', '2.102.0']) {
      const log = adapter.jobLog(repo, check, version);
      if (log) named.push({ name: `jobLog(${check.name}, ${version})`, call: log, scoped: true });
    }
    const notes = adapter.annotations(repo, check);
    if (notes) named.push({ name: `annotations(${check.name})`, call: notes, scoped: true });
    const play = adapter.playManual(repo, check);
    if (play) named.push({ name: `playManual(${check.name})`, call: play, scoped: true });
  }
  const pipelines = [null, { id: 777, status: 'failed', sha: null, source: 'merge_request_event' }, { id: 778, status: 'failed', sha: null, source: 'push' }];
  for (const headPipeline of pipelines) {
    for (const scope of ['failed', 'all'] as const) {
      add(`rerun(${scope})`, adapter.rerun(repo, { scope, checks: SAMPLE_CHECKS, number: 4242, branch: HEAD, headPipeline }));
    }
  }
  add('rerun(check)', adapter.rerun(repo, { scope: 'check', checkId: '1001', checks: SAMPLE_CHECKS, number: 4242, branch: HEAD, headPipeline: null }));
  add('cancel', adapter.cancel(repo, { checks: SAMPLE_CHECKS, pipelineId: 777 }));
  add('required', adapter.required(repo, 'release/2026.10'));
  return named;
}

const isAbsoluteUrl = (word: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(word);

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** The `api` endpoint: the first word after `api` that is not a flag or a flag's value we know. */
function apiPath(args: string[]): string | undefined {
  const valued = new Set(['--hostname', '-X', '--method', '-H', '--header', '--jq', '-q', '--cache', '--input', '--output']);
  for (let at = 1; at < args.length; at += 1) {
    const word = args[at];
    if (word === undefined) break;
    if (valued.has(word)) {
      at += 1;
      continue;
    }
    if (!word.startsWith('-')) return word;
  }
  return undefined;
}

function pinning({ adapter, manifest, repo }: ConformanceOptions, { name, call, scoped }: NamedCall): string[] {
  const problems: string[] = [];
  if (!scoped) {
    if (name === 'version' && call.args.join(' ') !== manifest.versions.args.join(' ')) {
      problems.push(`version() must run ${manifest.cli} ${manifest.versions.args.join(' ')}, not ${call.args.join(' ')}`);
    }
    if (name === 'authStatus') {
      const auth = manifest.auth;
      const expected = auth.kind === 'hosts-json' ? auth.args : [...auth.args, auth.hostFlag, repo.host];
      if (call.args.join(' ') !== expected.join(' ')) {
        problems.push(`authStatus() must run ${manifest.cli} ${expected.join(' ')}, not ${call.args.join(' ')}`);
      }
    }
    return problems;
  }
  if (call.host !== repo.host) problems.push(`${name}() is pinned to host ${String(call.host)}, not ${repo.host}`);
  if (call.args[0] === 'api' && call.args.includes('graphql')) {
    // A GraphQL call has no path: the repository is in its variables
    if (valueAfter(call.args, '--hostname') !== repo.host) problems.push(`${name}() is an api call without --hostname ${repo.host}`);
    const fields = call.args.filter((word) => word.startsWith('owner=') || word.startsWith('repo='));
    if (!fields.includes(`owner=${repo.owner}`) || !fields.includes(`repo=${repo.name}`)) {
      problems.push(`${name}() is a graphql call that does not carry owner=${repo.owner} and repo=${repo.name}`);
    }
  } else if (call.args[0] === 'api') {
    if (valueAfter(call.args, '--hostname') !== repo.host) problems.push(`${name}() is an api call without --hostname ${repo.host}`);
    const path = apiPath(call.args);
    const scope = adapter.id === 'github' ? `repos/${repo.owner}/${repo.name}` : `projects/${String(repo.projectId)}`;
    if (!path || !(path === scope || path.startsWith(`${scope}/`) || path.startsWith(`${scope}?`))) {
      problems.push(`${name}() must call a relative path under ${scope}, not ${String(path)}`);
    }
    if (path && /[{}]/.test(path)) problems.push(`${name}() uses a {placeholder} in its api path: ${path}`);
  } else {
    // gh pins `-R host/owner/repo`; glab pins the URL form, because group/sub/project is ambiguous with a host prefix.
    const wanted = manifest.cli === 'gh' ? `${repo.host}/${repo.owner}/${repo.name}` : `https://${repo.host}/${repo.path}`;
    if (valueAfter(call.args, '-R') !== wanted) problems.push(`${name}() must carry -R ${wanted}`);
  }
  return problems;
}

function noForbidden({ name, call }: NamedCall): string[] {
  const problems: string[] = [];
  if (call.args[0] === 'api') {
    for (const word of call.args.slice(1)) {
      if (isAbsoluteUrl(word)) problems.push(`${name}() passes an absolute URL to api: ${word}`);
    }
  }
  const [group, verb] = call.args;
  if (verb === 'delete' && (group === 'mr' || group === 'pr' || group === 'repo' || group === 'issue')) {
    problems.push(`${name}() builds "${group} delete", which deletes without asking when there is no terminal`);
  }
  // `auth status --json hosts` is one field by design: the rule is about reading a pull request
  const json = group === 'pr' ? valueAfter(call.args, '--json') : undefined;
  if (json !== undefined && json.split(',').filter(Boolean).length < 2) {
    problems.push(`${name}() asks --json ${json}: ask for at least two real fields (2.92 invents {"number":N})`);
  }
  return problems;
}

export type ConformanceReport = Record<string, string[]>;

/** Every rule of the suite, each with the violations found: empty means it holds. */
export function checkConformance(options: ConformanceOptions): ConformanceReport {
  const { adapter, manifest, classify, recorded } = options;
  const all = calls(options);
  const report: ConformanceReport = {};

  report['every call is argv for the manifest’s CLI, without a shell'] = all.flatMap(({ name, call }) => {
    const problems: string[] = [];
    if (call.cli !== manifest.cli) problems.push(`${name}() runs ${call.cli}, the manifest says ${manifest.cli}`);
    if (!Array.isArray(call.args) || call.args.some((word) => typeof word !== 'string')) {
      problems.push(`${name}() args are not an array of strings`);
      return problems;
    }
    // "--head foo" as one word is a shell string pasted into an array
    for (const word of call.args) {
      if (/^-{1,2}[\w-]+\s/.test(word)) problems.push(`${name}() has a shell-style word: ${word}`);
    }
    if (call.args.some((word) => word === 'sh' || word === '-c')) problems.push(`${name}() runs through a shell`);
    if (!CALL_CLASSES.includes(call.class)) problems.push(`${name}() has an unknown class ${String(call.class)}`);
    return problems;
  });

  report['every repository call is pinned to its host and repository'] = all.flatMap((named) => pinning(options, named));

  report['no call builds an absolute api URL, a delete, or a lone --json number'] = all.flatMap(noForbidden);

  report['env() sets and removes what the execution layer lists'] = (() => {
    const problems: string[] = [];
    const env = adapter.env();
    const expected = EXPECTED_ENV[manifest.cli];
    for (const [name, value] of Object.entries(expected.set)) {
      if (env.set[name] !== value) problems.push(`env().set must have ${name}=${value}, has ${String(env.set[name])}`);
    }
    for (const name of expected.unset) {
      if (!env.unset.includes(name)) problems.push(`env().unset must remove ${name}`);
    }
    for (const name of Object.keys(env.set)) {
      if (env.unset.includes(name)) problems.push(`env() both sets and removes ${name}`);
    }
    return problems;
  })();

  report['create carries the body only on stdin'] = (() => {
    const call = adapter.create(options.repo, { head: HEAD, base: BASE, title: TITLE, body: BODY });
    const problems: string[] = [];
    if (call.input !== BODY) problems.push('create() must pass the body as `input`, unchanged');
    if (call.args.some((word) => word.includes('ends here') || word.includes('subshell'))) problems.push('create() puts the body in argv');
    const file = valueAfter(call.args, '--body-file') ?? valueAfter(call.args, '--description-file');
    if (file !== '-') problems.push(`create() must read the body from stdin (-), not ${String(file)}`);
    if (call.kind !== 'write') problems.push('create() is a write');
    return problems;
  })();

  report['find asks for the head and the base'] = (() => {
    const call = adapter.find(options.repo, { head: HEAD, base: BASE });
    const problems: string[] = [];
    if (!call.args.includes(HEAD)) problems.push('find() does not ask for the head branch');
    if (!call.args.includes(BASE)) problems.push('find() does not ask for the base branch');
    if (call.kind !== 'read') problems.push('find() is a read');
    return problems;
  })();

  report['view asks for the number it was given'] = (() => {
    const call = adapter.view(options.repo, 4242);
    return call.args.includes('4242') ? [] : ['view() does not carry the change request number'];
  })();

  report['refPrefix and id match the manifest'] = [
    ...(adapter.refPrefix === manifest.refPrefix ? [] : [`refPrefix ${adapter.refPrefix} ≠ manifest ${manifest.refPrefix}`]),
    ...(adapter.id === manifest.id ? [] : [`id ${adapter.id} ≠ manifest ${manifest.id}`]),
  ];

  report['every call’s kind agrees with the classifier'] = all.flatMap(({ name, call }) =>
    classify(call) === call.kind ? [] : [`${name}() declares ${call.kind}, the classifier says ${classify(call)}`],
  );

  report['parsers map every recorded output'] = (() => {
    const problems: string[] = [];
    const attempt = (what: string, run: () => void) => {
      try {
        run();
      } catch (error) {
        problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const item of recorded?.versions ?? []) {
      attempt(`parseVersion ${item.name}`, () => assert.deepEqual(adapter.parseVersion(item.stdout), item.expect));
    }
    for (const item of recorded?.views ?? []) {
      attempt(`parseView ${item.name}`, () => assert.deepEqual(adapter.parseView(item.stdout), item.expect));
    }
    for (const item of recorded?.finds ?? []) {
      attempt(`parseFind ${item.name}`, () => assert.deepEqual(adapter.parseFind(item.stdout), item.expect));
    }
    for (const item of recorded?.defaultBranches ?? []) {
      attempt(`parseDefaultBranch ${item.name}`, () => assert.deepEqual(adapter.parseDefaultBranch(item.stdout), item.expect));
    }
    for (const item of recorded?.auth ?? []) {
      const result: HostResult = {
        stderrFirstLine: '',
        http: null,
        truncated: false,
        durationMs: 0,
        ...item.result,
      };
      attempt(`parseAuth ${item.name}`, () => assert.deepEqual(adapter.parseAuth(result, item.hostname), item.expect));
    }
    return problems;
  })();

  report['parseView throws HostParseError on a shape it cannot read'] = (() => {
    const problems: string[] = [];
    const outputs = [...GENERIC_MALFORMED.map((stdout) => ({ name: JSON.stringify(stdout), stdout })), ...(recorded?.malformedViews ?? [])];
    for (const { name, stdout } of outputs) {
      try {
        adapter.parseView(stdout);
        problems.push(`parseView accepted ${name}`);
      } catch (error) {
        if (!(error instanceof HostParseError)) problems.push(`parseView threw something other than HostParseError on ${name}`);
      }
    }
    return problems;
  })();

  if (adapter.checks && adapter.parseChecks && adapter.rerun && adapter.cancel && adapter.jobLog && adapter.playManual) {
    const checksAdapter = adapter as CodeHostAdapter & ChecksAdapter;
    const sample = (name: string): Check => SAMPLE_CHECKS.find((c) => c.name === name) as Check;
    const wrap = (stdout: string, exitCode = 0): HostResult => ({ exitCode, stdout, stderrFirstLine: '', http: null, truncated: false, durationMs: 0 });

    report['only the calls that change a check are writes, and they are class write'] = (() => {
      const problems: string[] = [];
      for (const { name, call } of all.filter((n) => !/^(version|authStatus|defaultBranch|create|find|view)$/.test(n.name))) {
        const writes = /^(rerun|cancel|playManual)/.test(name);
        if ((call.kind === 'write') !== writes) problems.push(`${name}() is declared ${call.kind}`);
        if (writes && call.class !== 'write' && call.class !== 'long-write') problems.push(`${name}() is a write of class ${call.class}`);
      }
      return problems;
    })();

    report['a log is one read of class log, never followed or paged'] = (() => {
      const problems: string[] = [];
      for (const { name, call } of all.filter((n) => n.name.startsWith('jobLog'))) {
        if (call.class !== 'log') problems.push(`${name} must be class log`);
        if (call.args[0] === 'ci') problems.push(`${name} follows the log`);
        if (call.args.includes('--paginate')) problems.push(`${name} pages a log`);
      }
      return problems;
    })();

    report['a check without a log, or that cannot be run again, builds no call, and an id is digits only'] = (() => {
      const problems: string[] = [];
      if (checksAdapter.jobLog(options.repo, sample('child'), '2.102.0') !== null) problems.push('jobLog() built a call for a bridge');
      if (checksAdapter.jobLog(options.repo, sample('ci/other'), '2.102.0') !== null) problems.push('jobLog() built a call for a commit status');
      for (const hostile of ['1; rm -rf', '--help', '../x']) {
        try {
          const call = checksAdapter.jobLog(options.repo, { ...sample('build'), id: hostile }, '2.102.0');
          // a host that has no log for the sample answers null, which is no call either
          if (call) problems.push(`jobLog() accepted the id ${hostile}: ${call.args.join(' ')}`);
        } catch (error) {
          if (!(error instanceof HostParseError)) problems.push(`jobLog() threw something other than HostParseError on ${hostile}`);
        }
      }
      try {
        checksAdapter.rerun(options.repo, { scope: 'check', checkId: '1002', checks: SAMPLE_CHECKS, number: 1, branch: HEAD, headPipeline: null });
        problems.push('rerun(check) accepted a running check');
      } catch (error) {
        if (!(error instanceof HostRequestError) || error.reason !== 'check-not-rerunnable') {
          problems.push('rerun(check) must throw HostRequestError check-not-rerunnable on a running check');
        }
      }
      return problems;
    })();

    report['parseChecks maps every recorded output'] = (recorded?.checks ?? []).flatMap((item) => {
      try {
        const parsed = checksAdapter.parseChecks(options.repo, item.ref, item.results.map((stdout) => wrap(stdout)));
        assert.equal(parsed.checks.length, item.expect.checks.length, 'number of checks');
        assert.deepEqual(parsed.checks.map((c, at) => pick(c, item.expect.checks[at])), item.expect.checks);
        assert.equal(parsed.truncated, item.expect.truncated, 'truncated');
        assert.equal(parsed.next.length, item.expect.next, 'follow-up calls');
        return [];
      } catch (error) {
        return [`parseChecks ${item.name}: ${error instanceof Error ? error.message : String(error)}`];
      }
    });

    report['parseChecks throws HostParseError on output it cannot read, and on a failed read'] = (() => {
      const problems: string[] = [];
      const ref = { headSha: 'abc123def', pipelineId: 777 };
      const cases = [
        ...['not json', '"text"', '[1]'].map((stdout) => ({ name: JSON.stringify(stdout), results: [stdout, stdout] })),
        ...(recorded?.malformedChecks ?? []),
      ];
      for (const { name, results } of cases) {
        try {
          checksAdapter.parseChecks(options.repo, ref, results.map((stdout) => wrap(stdout)));
          problems.push(`parseChecks accepted ${name}`);
        } catch (error) {
          if (!(error instanceof HostParseError)) problems.push(`parseChecks threw something other than HostParseError on ${name}`);
        }
      }
      try {
        checksAdapter.parseChecks(options.repo, ref, [wrap('[]', 1), wrap('[]', 0)]);
        problems.push('parseChecks accepted a read that exited 1');
      } catch (error) {
        if (!(error instanceof HostParseError)) problems.push('parseChecks threw something other than HostParseError on a failed read');
      }
      return problems;
    })();
  }

  return report;
}

/** The fields of `actual` that `expected` names: a recorded list is compared on what the test cares about. */
function pick(actual: Check, expected: Partial<Check> | undefined): Partial<Check> {
  if (!expected) return actual;
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key as keyof Check]]));
}

/** Registers one test per rule, named after the adapter. */
export function runConformance(options: ConformanceOptions): void {
  const report = checkConformance(options);
  for (const [rule, problems] of Object.entries(report)) {
    test(`${options.manifest.id} adapter: ${rule}`, () => {
      assert.deepEqual(problems, []);
    });
  }
}
