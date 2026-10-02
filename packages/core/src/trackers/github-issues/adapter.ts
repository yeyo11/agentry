import { HostParseError, type HostCall, type HostRepo } from '../../hosts/code-host.ts';
import { parseJson } from '../../hosts/json.ts';
import {
  checkBody,
  checkLabels,
  IssueIsPullRequest,
  ISSUES_CEILING,
  ISSUES_PAGE_SIZE,
  issueNumber,
  parseCommentUrl,
  parseCreatedUrl,
  TrackerInputError,
  type IssueRead,
  type TrackerAdapter,
  type TrackerLabel,
} from '../tracker.ts';

// GitHub Issues is gh's own `issue` and `label` commands, pinned to the host and repository on every
// call. Every argument and field below is what gh 2.92.0 and 2.102.0 were recorded to take and
// print (recordings/gh/NOTES.md, §A5 and §B8); the two releases are identical for all of it. Never
// `--type` (2.102 creates the issue, then exits 1) and never `gh issue develop` (outside a clone it
// creates the branch, then exits 1).

const pin = (repo: HostRepo): string => `${repo.host}/${repo.owner}/${repo.name}`;

const read = (repo: HostRepo, args: string[]): HostCall => ({ cli: 'gh', args, kind: 'read', class: 'read', host: repo.host, bucket: 'graphql' });
const write = (repo: HostRepo, args: string[], input?: string): HostCall => ({
  cli: 'gh',
  args,
  ...(input === undefined ? {} : { input }),
  kind: 'write',
  class: 'write',
  host: repo.host,
  bucket: 'graphql',
});

/** The fields every issue read asks for: all are in the recorded field list of `gh issue view/list --json`. */
const ISSUE_FIELDS = 'number,title,body,state,stateReason,labels,url,updatedAt,closedByPullRequestsReferences';

function parseValue(stdout: string, what: string): unknown {
  try {
    return parseJson(stdout);
  } catch {
    throw new HostParseError(`${what} is not JSON`);
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostParseError(`${what} is not an object`);
  return value as Record<string, unknown>;
}

/** A label is an object with a `name`; a bare string is accepted too, as `--jq` prints them. */
function labelNames(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HostParseError(`${what} labels are not an array`);
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    const name = asObject(entry, `${what} label`).name;
    if (typeof name !== 'string') throw new HostParseError(`${what} has a label without a name`);
    return name;
  });
}

/** `COMPLETED` → `completed`, `NOT_PLANNED` → `not-planned`; open issues print an empty string. */
const reasonOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value.toLowerCase().replace(/_/g, '-') : null);

function closedBy(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const number = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).number : undefined;
    return typeof number === 'number' && Number.isSafeInteger(number) ? [number] : [];
  });
}

function issueOf(raw: unknown, what: string): IssueRead {
  const issue = asObject(raw, what);
  const { number, title, state, url } = issue;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw new HostParseError(`${what} has no number`);
  if (typeof title !== 'string') throw new HostParseError(`${what} has no title`);
  const lower = typeof state === 'string' ? state.toLowerCase() : '';
  if (lower !== 'open' && lower !== 'closed') throw new HostParseError(`${what} has an unknown state: ${String(state)}`);
  return {
    key: String(number),
    externalId: null,
    title,
    body: typeof issue.body === 'string' ? issue.body : '',
    state: lower,
    stateReason: reasonOf(issue.stateReason),
    labels: labelNames(issue.labels, what),
    url: typeof url === 'string' && url !== '' ? url : null,
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
    closedByChangeRequests: closedBy(issue.closedByPullRequestsReferences),
  };
}

export const githubIssuesAdapter: TrackerAdapter = {
  id: 'github-issues',
  host: 'github',
  cli: 'gh',

  // gh has no page argument: page N reads up to N pages' worth plus one, capped at the ceiling, and
  // `parseList` cuts the page out of it. The extra one says whether there is more.
  list(repo, { query, page }) {
    if (!Number.isInteger(page) || page < 1) throw new TrackerInputError('the page starts at 1');
    const limit = Math.min(page * ISSUES_PAGE_SIZE + 1, ISSUES_CEILING);
    const args = ['issue', 'list', '-R', pin(repo), '--state', 'open', '--limit', String(limit)];
    if (query.trim() !== '') args.push('--search', query);
    args.push('--json', ISSUE_FIELDS);
    return read(repo, args);
  },
  parseList(stdout, { page }) {
    const all = parseValue(stdout, 'issue list');
    if (!Array.isArray(all)) throw new HostParseError('issue list is not an array');
    const from = (page - 1) * ISSUES_PAGE_SIZE;
    const issues = all.slice(from, from + ISSUES_PAGE_SIZE).map((entry) => issueOf(entry, 'issue list entry'));
    // Past the ceiling gh was never asked for more, so the last page is the end: the caller says "first 500"
    return { issues, page, hasMore: all.length > from + ISSUES_PAGE_SIZE && from + ISSUES_PAGE_SIZE < ISSUES_CEILING };
  },

  get: (repo, key) => read(repo, ['issue', 'view', String(issueNumber(key)), '-R', pin(repo), '--json', ISSUE_FIELDS]),
  parseGet(stdout) {
    const issue = asObject(parseValue(stdout, 'issue view'), 'issue view');
    // `gh issue view <PR number>` resolves the pull request and exits 0 (recorded on 2.45, 2.92 and 2.102)
    if (typeof issue.url === 'string' && issue.url.includes('/pull/')) throw new IssueIsPullRequest(String(issue.number));
    return issueOf(issue, 'issue view');
  },

  // The body travels on stdin only: it is up to 60 000 characters and may hold anything
  create(repo, { title, body, labels }) {
    const args = ['issue', 'create', '-R', pin(repo), '--title', title, '--body-file', '-'];
    for (const label of checkLabels(labels)) args.push('--label', label);
    return write(repo, args, checkBody(body));
  },
  parseCreated: parseCreatedUrl,

  update(repo, key, { title, body, addLabels, removeLabels }) {
    const args = ['issue', 'edit', String(issueNumber(key)), '-R', pin(repo)];
    const bare = args.length;
    if (title !== undefined) args.push('--title', title);
    if (body !== undefined) args.push('--body-file', '-');
    for (const label of checkLabels(addLabels)) args.push('--add-label', label);
    for (const label of checkLabels(removeLabels)) args.push('--remove-label', label);
    if (args.length === bare) throw new TrackerInputError('nothing to change');
    return write(repo, args, body === undefined ? undefined : checkBody(body));
  },

  comment: (repo, key, body) => write(repo, ['issue', 'comment', String(issueNumber(key)), '-R', pin(repo), '--body-file', '-'], checkBody(body)),
  parseCommented: parseCommentUrl,

  setStatus: (repo, key, { column }) => (column === 'done' ? githubIssuesAdapter.close(repo, key, 'completed') : null),
  // `--reason` is one word: gh takes "not planned" with the space
  close: (repo, key, reason) =>
    write(repo, ['issue', 'close', String(issueNumber(key)), '-R', pin(repo), '--reason', reason === 'not-planned' ? 'not planned' : 'completed']),
  reopen: (repo, key) => write(repo, ['issue', 'reopen', String(issueNumber(key)), '-R', pin(repo)]),

  labels: (repo) => read(repo, ['label', 'list', '-R', pin(repo), '--limit', '200', '--json', 'name,color,description']),
  parseLabels(stdout): TrackerLabel[] {
    const labels = parseValue(stdout, 'label list');
    if (!Array.isArray(labels)) throw new HostParseError('label list is not an array');
    return labels.map((entry) => {
      const label = asObject(entry, 'label list entry');
      if (typeof label.name !== 'string') throw new HostParseError('label list entry has no name');
      return { name: label.name, color: typeof label.color === 'string' ? label.color : '', description: typeof label.description === 'string' ? label.description : '' };
    });
  },
};
