import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HostParseError,
  type ChangeRequestView,
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
  auth?: Array<{
    name: string;
    hostname: string;
    result: Partial<HostResult> & { stdout: string; exitCode: number | null };
    expect: { signedIn: boolean; user: string | null };
  }>;
}

export interface ConformanceOptions {
  adapter: CodeHostAdapter;
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

const isAbsoluteUrl = (word: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(word);

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** The `api` endpoint: the first word after `api` that is not a flag or a flag's value we know. */
function apiPath(args: string[]): string | undefined {
  const valued = new Set(['--hostname', '-X', '--method', '-H', '--header', '--jq', '-q', '--cache', '--input']);
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
  if (call.args[0] === 'api') {
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

  return report;
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
