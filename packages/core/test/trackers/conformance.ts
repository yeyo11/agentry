import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostParseError, type HostCall, type HostRepo } from '../../src/hosts/code-host.ts';
import type { CodeHostManifest } from '../../src/hosts/manifest.ts';
import { MAX_ISSUE_BODY, TrackerInputError, type IssueCloseReason, type TrackerAdapter } from '../../src/trackers/tracker.ts';

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
  /**
   * Where a body travels. GitHub takes it on stdin (`--body-file -`); the recorded GitLab issue
   * commands take it as one argv word (`-d`, `-m`), which is fine for issue text: it is not secret
   * and is cut at 60 000 characters.
   */
  bodyIn: 'stdin' | 'argv';
  /** Output every parser must refuse, besides the generic malformed ones: it is a different CLI's shape */
  malformedIssues?: Array<{ name: string; stdout: string }>;
}

const BODY = 'Objective: ship it\n\n- "quoted" and `ticks` and $(subshell)\n- ends here\n';
const TITLE = 'Fix the login & wait';
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
  add('create', adapter.create(repo, { title: TITLE, body: BODY }));
  add('create(labels)', adapter.create(repo, { title: TITLE, body: BODY, labels: ['bug', 'help wanted'] }));
  add('update(title)', adapter.update(repo, KEY, { title: TITLE }));
  add('update(body)', adapter.update(repo, KEY, { body: BODY }));
  add('update(labels)', adapter.update(repo, KEY, { addLabels: ['bug'], removeLabels: ['wontfix', 'help wanted'] }));
  add('update(all)', adapter.update(repo, KEY, { title: TITLE, body: BODY, addLabels: ['bug'], removeLabels: ['wontfix'] }));
  add('comment', adapter.comment(repo, KEY, BODY));
  for (const reason of ['completed', 'not-planned'] as IssueCloseReason[]) add(`close(${reason})`, adapter.close(repo, KEY, reason));
  add('reopen', adapter.reopen(repo, KEY));
  for (const column of ['in_progress', 'in_review', 'done'] as const) add(`setStatus(${column})`, adapter.setStatus(repo, KEY, { column, name: null }));
  add('labels', adapter.labels(repo));
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
  const { adapter, hostManifest, repo, classify, bodyIn } = options;
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
      if (/^-{1,2}[\w-]+\s/.test(word) && !HOSTILE_QUERIES.includes(word) && word !== TITLE && word !== BODY) problems.push(`${name}() has a shell-style word: ${word}`);
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
    const mutating = /^(create|update|comment|close|reopen|setStatus)/.test(name);
    const problems: string[] = [];
    if (mutating && call.kind !== 'write') problems.push(`${name}() changes the issue and must be a write`);
    if (!mutating && call.kind !== 'read') problems.push(`${name}() only reads and must be a read`);
    if (call.kind === 'read' && call.input !== undefined) problems.push(`${name}() is a read with a body`);
    return problems;
  });

  report['bodies travel where the adapter says and never inside the other place'] = (() => {
    const problems: string[] = [];
    for (const [name, call] of [
      ['create', adapter.create(repo, { title: TITLE, body: BODY })],
      ['comment', adapter.comment(repo, KEY, BODY)],
      ['update(body)', adapter.update(repo, KEY, { body: BODY })],
    ] as const) {
      const inArgv = call.args.includes(BODY);
      if (bodyIn === 'stdin') {
        if (call.input !== BODY) problems.push(`${name}() must pass the body as stdin, unchanged`);
        if (call.args.some((word) => word.includes('ends here') || word.includes('subshell'))) problems.push(`${name}() puts the body in argv`);
        if (valueAfter(call.args, '--body-file') !== '-') problems.push(`${name}() must read the body with --body-file -`);
      } else {
        if (!inArgv) problems.push(`${name}() must pass the body as one argv word`);
        if (call.input !== undefined) problems.push(`${name}() also sends the body on stdin`);
      }
    }
    return problems;
  })();

  report['a title is one argv word that follows its flag'] = (() => {
    const call = adapter.create(repo, { title: TITLE, body: BODY });
    return valueAfter(call.args, adapter.cli === 'gh' ? '--title' : '-t') === TITLE ? [] : ['create() does not pass the title as the value of its flag'];
  })();

  report['a query stays one argv word after --search, whatever it says'] = HOSTILE_QUERIES.flatMap((query) => {
    const call = adapter.list(repo, { query, page: 1 });
    return valueAfter(call.args, '--search') === query && call.args.filter((word) => word === query).length === 1 ? [] : [`list(${query}) does not carry the query as the one value of --search`];
  });

  report['an empty query adds no search'] = adapter.list(repo, { query: '  ', page: 1 }).args.includes('--search') ? ['list("  ") passes --search'] : [];

  report['a key that is not an issue number never reaches argv'] = BAD_KEYS.flatMap((key) => {
    const problems: string[] = [];
    const attempts: Array<[string, () => unknown]> = [
      ['get', () => adapter.get(repo, key)],
      ['update', () => adapter.update(repo, key, { title: TITLE })],
      ['comment', () => adapter.comment(repo, key, BODY)],
      ['close', () => adapter.close(repo, key, 'completed')],
      ['reopen', () => adapter.reopen(repo, key)],
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
    check('a body over the limit on create', () => adapter.create(repo, { title: TITLE, body: 'x'.repeat(MAX_ISSUE_BODY + 1) }));
    check('a body over the limit on comment', () => adapter.comment(repo, KEY, 'x'.repeat(MAX_ISSUE_BODY + 1)));
    check('a label with a comma', () => adapter.create(repo, { title: TITLE, body: BODY, labels: ['a,b'] }));
    check('an empty label', () => adapter.update(repo, KEY, { addLabels: [' '] }));
    check('an update that changes nothing', () => adapter.update(repo, KEY, {}));
    check('page 0', () => adapter.list(repo, { query: '', page: 0 }));
    check('a fractional page', () => adapter.list(repo, { query: '', page: 1.5 }));
    if (refuses(() => adapter.create(repo, { title: TITLE, body: 'x'.repeat(MAX_ISSUE_BODY) }))) problems.push('a body at the limit was refused');
    return problems;
  })();

  report['only done writes a status; every other column is nothing to do'] = (() => {
    const problems: string[] = [];
    if (adapter.setStatus(repo, KEY, { column: 'in_progress', name: 'In Progress' }) !== null) problems.push('in_progress writes');
    if (adapter.setStatus(repo, KEY, { column: 'in_review', name: 'In Review' }) !== null) problems.push('in_review writes');
    const done = adapter.setStatus(repo, KEY, { column: 'done', name: 'Done' });
    if (!done) problems.push('done does not write');
    else if (done.args.join(' ') !== adapter.close(repo, KEY, 'completed').args.join(' ')) problems.push('done is not a close as completed');
    return problems;
  })();

  report['create labels pass one flag per label (gh) or one comma list (glab)'] = (() => {
    const call = adapter.create(repo, { title: TITLE, body: BODY, labels: ['bug', 'help wanted'] });
    if (adapter.cli === 'gh') {
      const labels = call.args.flatMap((word, at) => (word === '--label' ? [call.args[at + 1]] : []));
      return labels.join('|') === 'bug|help wanted' ? [] : [`gh create passes labels ${JSON.stringify(labels)}`];
    }
    return valueAfter(call.args, '-l') === 'bug,help wanted' ? [] : ['glab create does not pass labels as one comma list'];
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
    for (const stdout of ['', 'not a url', 'https://example.com/other', '- Creating issue in o/r']) {
      for (const [name, run] of [
        ['parseCreated', () => adapter.parseCreated(stdout)],
        ['parseCommented', () => adapter.parseCommented(stdout)],
      ] as const) {
        try {
          run();
          problems.push(`${name} accepted ${JSON.stringify(stdout)}`);
        } catch (error) {
          if (!(error instanceof HostParseError)) problems.push(`${name} threw ${String(error)} for ${JSON.stringify(stdout)}`);
        }
      }
    }
    for (const stdout of ['not json', '{}', '[{"color":"x"}]']) {
      try {
        adapter.parseLabels(stdout);
        problems.push(`parseLabels accepted ${JSON.stringify(stdout)}`);
      } catch (error) {
        if (!(error instanceof HostParseError)) problems.push(`parseLabels threw ${String(error)} for ${JSON.stringify(stdout)}`);
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
