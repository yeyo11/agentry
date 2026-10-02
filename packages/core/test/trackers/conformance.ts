import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostParseError, type HostCall, type HostRepo } from '../../src/hosts/code-host.ts';
import type { CodeHostManifest } from '../../src/hosts/manifest.ts';
import { TrackerInputError, type TrackerAdapter } from '../../src/trackers/tracker.ts';

/**
 * The conformance suite every tracker adapter passes (docs/plans/code-hosts.md, "Fakes and tests,
 * for every phase"), in the two layers of the code host suite: `checkTrackerConformance` returns the
 * violations of each rule as sentences, `runTrackerConformance` registers one test per rule.
 */

export interface TrackerConformanceOptions {
  adapter: TrackerAdapter;
  /** The manifest of the code host whose CLI the tracker uses */
  hostManifest: CodeHostManifest;
  repo: HostRepo;
  /** The classifier of `hosts/classify.ts`: what the execution layer treats a call as */
  classify: (call: HostCall) => 'read' | 'write';
  /** Output every parser must refuse, besides the generic malformed ones: it is a different CLI's shape */
  malformedIssues?: Array<{ name: string; stdout: string }>;
}

const KEY = '4242';

/** Text a hostile issue or query could hold: it must stay one argv word, never a flag or a verb. */
const HOSTILE_QUERIES = ['close', 'update', '--repo=evil/evil', '-R other/repo', 'is:open label:"bug fix"', '$(rm -rf ~)'];

/** Keys that are not issue numbers: none may reach argv, where they could be read as a flag. */
const BAD_KEYS = ['', ' ', '0', '-1', '12 --repo x', '--repo=evil/evil', '12abc', 'PROJ-12', '1e3', '#', '12\n', '99999999999'];

const GENERIC_MALFORMED = ['', 'not json', 'null', '42', '"text"', '{"error":{"message":"404 Not Found"}}', '[{}]'];

const CALL_CLASSES: ReadonlyArray<HostCall['class']> = ['probe', 'read', 'write', 'log', 'long-write'];

interface NamedCall {
  name: string;
  call: HostCall;
}

function calls({ adapter, repo }: TrackerConformanceOptions): NamedCall[] {
  const named: NamedCall[] = [];
  const add = (name: string, call: HostCall | null): void => {
    if (call) named.push({ name, call });
  };
  add('list', adapter.list(repo, { query: '', page: 1 }));
  add('list(query, page 3)', adapter.list(repo, { query: 'login bug', page: 3 }));
  for (const query of HOSTILE_QUERIES) add(`list(${query})`, adapter.list(repo, { query, page: 1 }));
  add('get', adapter.get(repo, KEY));
  add('get(#key)', adapter.get(repo, `#${KEY}`));
  add('close', adapter.close(repo, KEY));
  for (const column of ['in_progress', 'in_review', 'done'] as const) add(`setStatus(${column})`, adapter.setStatus(repo, KEY, { column, name: null }));
  add('what a change request closes', adapter.closedByChangeRequest(repo, 7));
  return named;
}

const isAbsoluteUrl = (word: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(word);

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** What the adapter throws for input it must refuse before any call. */
function refuses(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof TrackerInputError;
  }
}

export type TrackerConformanceReport = Record<string, string[]>;

export function checkTrackerConformance(options: TrackerConformanceOptions): TrackerConformanceReport {
  const { adapter, hostManifest, repo, classify } = options;
  const all = calls(options);
  const report: TrackerConformanceReport = {};

  report['every call is argv for the host’s CLI, without a shell'] = all.flatMap(({ name, call }) => {
    const problems: string[] = [];
    if (call.cli !== hostManifest.cli) problems.push(`${name}() runs ${call.cli}, the host’s CLI is ${hostManifest.cli}`);
    if (call.cli !== adapter.cli) problems.push(`${name}() runs ${call.cli}, the adapter says ${adapter.cli}`);
    if (!Array.isArray(call.args) || call.args.some((word) => typeof word !== 'string')) {
      problems.push(`${name}() args are not an array of strings`);
      return problems;
    }
    // "--state open" as one word is a shell string pasted into an array; a hostile query is not one of ours
    for (const word of call.args) {
      if (/^-{1,2}[\w-]+\s/.test(word) && !HOSTILE_QUERIES.includes(word)) problems.push(`${name}() has a shell-style word: ${word}`);
    }
    if (call.args.some((word) => word === 'sh' || word === '-c')) problems.push(`${name}() runs through a shell`);
    if (!CALL_CLASSES.includes(call.class)) problems.push(`${name}() has an unknown class ${String(call.class)}`);
    return problems;
  });

  report['every call is pinned to its host and repository'] = all.flatMap(({ name, call }) => {
    const problems: string[] = [];
    if (call.host !== repo.host) problems.push(`${name}() is pinned to host ${String(call.host)}, not ${repo.host}`);
    if (call.args[0] === 'api') {
      if (valueAfter(call.args, '--hostname') !== repo.host) problems.push(`${name}() is an api call without --hostname ${repo.host}`);
      const path = call.args.find((word, at) => at > 0 && !word.startsWith('-') && call.args[at - 1] !== '--hostname' && call.args[at - 1] !== '--output');
      const scope = adapter.id === 'github-issues' ? `repos/${repo.owner}/${repo.name}` : `projects/${String(repo.projectId)}`;
      if (!path || !(path.startsWith(`${scope}/`) || path.startsWith(`${scope}?`))) problems.push(`${name}() must call a relative path under ${scope}, not ${String(path)}`);
      if (path && /[{}]/.test(path)) problems.push(`${name}() uses a {placeholder} in its api path: ${path}`);
    } else {
      const wanted = hostManifest.cli === 'gh' ? `${repo.host}/${repo.owner}/${repo.name}` : `https://${repo.host}/${repo.path}`;
      if (valueAfter(call.args, '-R') !== wanted) problems.push(`${name}() must carry -R ${wanted}`);
    }
    return problems;
  });

  report['no call builds an absolute api URL, a delete, a develop, or an issue type'] = all.flatMap(({ name, call }) => {
    const problems: string[] = [];
    if (call.args[0] === 'api') for (const word of call.args.slice(1)) if (isAbsoluteUrl(word)) problems.push(`${name}() passes an absolute URL to api: ${word}`);
    const [group, verb] = call.args;
    if (group === 'issue' && (verb === 'delete' || verb === 'develop')) problems.push(`${name}() builds "issue ${verb}"`);
    // 2.102's `--type` creates the issue and then exits 1; GitLab's `-t` is the title
    if (call.cli === 'gh' && call.args.includes('--type')) problems.push(`${name}() passes --type, which creates the issue and then fails`);
    return problems;
  });

  report['every call’s kind agrees with the classifier'] = all.flatMap(({ name, call }) =>
    classify(call) === call.kind ? [] : [`${name}() declares ${call.kind}, the classifier says ${classify(call)}`],
  );

  report['only the mutating actions are writes, and a read never carries a body'] = all.flatMap(({ name, call }) => {
    const mutating = /^(close|setStatus)/.test(name);
    const problems: string[] = [];
    if (mutating && call.kind !== 'write') problems.push(`${name}() changes the issue and must be a write`);
    if (!mutating && call.kind !== 'read') problems.push(`${name}() only reads and must be a read`);
    if (call.kind === 'read' && call.input !== undefined) problems.push(`${name}() is a read with a body`);
    return problems;
  });

  report['a query stays one argv word after --search, whatever it says'] = HOSTILE_QUERIES.flatMap((query) => {
    const call = adapter.list(repo, { query, page: 1 });
    return valueAfter(call.args, '--search') === query && call.args.filter((word) => word === query).length === 1 ? [] : [`list(${query}) does not carry the query as the one value of --search`];
  });

  report['an empty query adds no search'] = adapter.list(repo, { query: '  ', page: 1 }).args.includes('--search') ? ['list("  ") passes --search'] : [];

  report['a key that is not an issue number never reaches argv'] = BAD_KEYS.flatMap((key) => {
    const problems: string[] = [];
    const attempts: Array<[string, () => unknown]> = [
      ['get', () => adapter.get(repo, key)],
      ['close', () => adapter.close(repo, key)],
      ['setStatus', () => adapter.setStatus(repo, key, { column: 'done', name: null })],
    ];
    for (const [name, run] of attempts) if (!refuses(run)) problems.push(`${name}("${key}") was not refused`);
    return problems;
  });

  report['input the CLI cannot take is refused before a call'] = (() => {
    const problems: string[] = [];
    const check = (what: string, run: () => unknown): void => {
      if (!refuses(run)) problems.push(`${what} was not refused`);
    };
    check('page 0', () => adapter.list(repo, { query: '', page: 0 }));
    check('a fractional page', () => adapter.list(repo, { query: '', page: 1.5 }));
    return problems;
  })();

  report['only done writes a status; every other column is nothing to do'] = (() => {
    const problems: string[] = [];
    if (adapter.setStatus(repo, KEY, { column: 'in_progress', name: 'In Progress' }) !== null) problems.push('in_progress writes');
    if (adapter.setStatus(repo, KEY, { column: 'in_review', name: 'In Review' }) !== null) problems.push('in_review writes');
    const done = adapter.setStatus(repo, KEY, { column: 'done', name: 'Done' });
    if (!done) problems.push('done does not write');
    else if (done.args.join(' ') !== adapter.close(repo, KEY).args.join(' ')) problems.push('done is not a close as completed');
    return problems;
  })();

  report['parsers refuse output that is not an issue'] = (() => {
    const problems: string[] = [];
    for (const stdout of [...GENERIC_MALFORMED, ...(options.malformedIssues ?? []).map((m) => m.stdout)]) {
      for (const [name, run] of [
        ['parseGet', () => adapter.parseGet(stdout)],
        ['parseList', () => adapter.parseList(stdout, { query: '', page: 1 })],
      ] as const) {
        try {
          run();
          problems.push(`${name} accepted ${JSON.stringify(stdout.slice(0, 60))}`);
        } catch (error) {
          if (!(error instanceof HostParseError)) problems.push(`${name} threw ${String(error)} for ${JSON.stringify(stdout.slice(0, 60))}`);
        }
      }
    }
    // Output that is not what the host prints for what a change request closes: never an empty list by accident
    for (const stdout of ['', 'not json', 'null', '42', '{}', '[{}]', '[{"iid":4}]']) {
      try {
        adapter.parseClosedByChangeRequest(stdout);
        problems.push(`parseClosedByChangeRequest accepted ${JSON.stringify(stdout)}`);
      } catch (error) {
        if (!(error instanceof HostParseError)) problems.push(`parseClosedByChangeRequest threw ${String(error)} for ${JSON.stringify(stdout)}`);
      }
    }
    return problems;
  })();

  return report;
}

/** Registers one test per rule, named after the adapter. */
export function runTrackerConformance(options: TrackerConformanceOptions): void {
  for (const [rule, problems] of Object.entries(checkTrackerConformance(options))) {
    test(`${options.adapter.id} adapter: ${rule}`, () => {
      assert.deepEqual(problems, []);
    });
  }
}
