import { HostParseError, type HostCall, type HostRepo } from '../../hosts/code-host.ts';
import { parseJson } from '../../hosts/json.ts';
import {
  checkBody,
  checkLabels,
  issueNumber,
  ISSUES_PAGE_SIZE,
  parseCommentUrl,
  parseCreatedUrl,
  requestNumber,
  TrackerInputError,
  type ClosedIssue,
  type IssueRead,
  type TrackerAdapter,
  type TrackerLabel,
} from '../tracker.ts';

// GitLab Issues is glab's own `issue` command, pinned to the project's URL on every call (`-R
// https://host/group/project`, because `group/sub/project` is ambiguous with a host prefix), and
// `glab api` on the numeric project id for the labels. Every argument and field below is what glab
// 1.120.0 was recorded to take and print (recordings/glab/NOTES.md §6, `t0a` in
// docs/plans/code-hosts.md). Two traps from the recordings: JSON on `issue list` is `-O json`
// (`-F` is the output format there), and every url glab prints says `work_items/<iid>`, which is
// the same issue: the key stays the `iid`.

const projectUrl = (repo: HostRepo): string => `https://${repo.host}/${repo.path}`;

const read = (repo: HostRepo, args: string[]): HostCall => ({ cli: 'glab', args, kind: 'read', class: 'read', host: repo.host });
const write = (repo: HostRepo, args: string[]): HostCall => ({ cli: 'glab', args, kind: 'write', class: 'write', host: repo.host });

/** glab's issue states; GitLab's `locked` belongs to merge requests only */
const STATES: Readonly<Record<string, IssueRead['state']>> = { opened: 'open', closed: 'closed' };

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

function issueOf(raw: unknown, what: string): IssueRead {
  const issue = asObject(raw, what);
  const { iid, id, title, state, labels } = issue;
  if (typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid < 1) throw new HostParseError(`${what} has no iid`);
  if (typeof title !== 'string') throw new HostParseError(`${what} has no title`);
  const mapped = typeof state === 'string' ? STATES[state] : undefined;
  if (mapped === undefined) throw new HostParseError(`${what} has an unknown state: ${String(state)}`);
  if (labels !== undefined && labels !== null && (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string'))) {
    throw new HostParseError(`${what} labels are not a list of names`);
  }
  return {
    key: String(iid),
    // The instance-wide id; it may be above 2^53 on a big instance, and `parseJson` then hands it back as a string
    externalId: typeof id === 'number' || typeof id === 'string' ? String(id) : null,
    title,
    body: typeof issue.description === 'string' ? issue.description : '',
    state: mapped,
    stateReason: null,
    labels: (labels ?? []) as string[],
    url: typeof issue.web_url === 'string' && issue.web_url !== '' ? issue.web_url : null,
    updatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : null,
    closedByChangeRequests: [],
  };
}

/** `-l a,b` and `-u a,b`: GitLab takes a comma list, so a name with a comma is refused by `checkLabels` */
const joined = (labels: string[]): string => labels.join(',');

/** The project path of an issue's `web_url`: `https://host/group/sub/project/-/work_items/12` */
const ISSUE_PATH = /^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/\d+$/;

function projectId(repo: HostRepo): number {
  if (repo.projectId === undefined) throw new TrackerInputError('the labels list is read on the numeric project id, which this repository does not have yet');
  return repo.projectId;
}

export const gitlabIssuesAdapter: TrackerAdapter = {
  id: 'gitlab-issues',
  host: 'gitlab',
  cli: 'glab',

  // Page N is `-P 100 -p N`; a short page is the end (recorded: the paging of `mr list`)
  list(repo, { query, page }) {
    if (!Number.isInteger(page) || page < 1) throw new TrackerInputError('the page starts at 1');
    const args = ['issue', 'list', '-R', projectUrl(repo), '-O', 'json', '-P', String(ISSUES_PAGE_SIZE), '-p', String(page)];
    if (query.trim() !== '') args.push('--search', query);
    return read(repo, args);
  },
  parseList(stdout, { page }) {
    const all = parseValue(stdout, 'issue list');
    if (!Array.isArray(all)) throw new HostParseError('issue list is not an array');
    return { issues: all.map((entry) => issueOf(entry, 'issue list entry')), page, hasMore: all.length >= ISSUES_PAGE_SIZE };
  },

  get: (repo, key) => read(repo, ['issue', 'view', String(issueNumber(key)), '-R', projectUrl(repo), '-F', 'json']),
  parseGet: (stdout) => issueOf(parseValue(stdout, 'issue view'), 'issue view'),

  // Labels passed are created on the fly, so the caller passes only ones it has just read
  create(repo, { title, body, labels }) {
    const args = ['issue', 'create', '-R', projectUrl(repo), '-t', title, '-d', checkBody(body)];
    const names = checkLabels(labels);
    if (names.length > 0) args.push('-l', joined(names));
    args.push('-y');
    return write(repo, args);
  },
  parseCreated: parseCreatedUrl,

  // `-u` removes a label and says "removed" also when it was not on the issue, so the caller re-reads
  update(repo, key, { title, body, addLabels, removeLabels }) {
    const args = ['issue', 'update', String(issueNumber(key)), '-R', projectUrl(repo)];
    const bare = args.length;
    if (title !== undefined) args.push('-t', title);
    const add = checkLabels(addLabels);
    if (add.length > 0) args.push('-l', joined(add));
    const remove = checkLabels(removeLabels);
    if (remove.length > 0) args.push('-u', joined(remove));
    if (body !== undefined) args.push('-d', checkBody(body));
    if (args.length === bare) throw new TrackerInputError('nothing to change');
    return write(repo, args);
  },

  comment: (repo, key, body) => write(repo, ['issue', 'note', String(issueNumber(key)), '-R', projectUrl(repo), '-m', checkBody(body)]),
  parseCommented: parseCommentUrl,

  writes: (column) => column === 'done',
  setStatus: (repo, key, { column }) => (column === 'done' ? gitlabIssuesAdapter.close(repo, key, 'completed') : null),
  // Idempotent: closing a closed issue exits 0 (recorded)
  close: (repo, key) => write(repo, ['issue', 'close', String(issueNumber(key)), '-R', projectUrl(repo)]),
  reopen: (repo, key) => write(repo, ['issue', 'reopen', String(issueNumber(key)), '-R', projectUrl(repo)]),

  // `closes_issues` is empty for a merge request into a non-default branch (recorded, NOTES §6). Recorded
  // empty only: a non-empty answer is the API's issue objects, whose `iid` and `web_url` are the ones
  // `issue view -F json` was recorded to print
  closedByChangeRequest: (repo, number) => read(repo, ['api', '--hostname', repo.host, `projects/${String(projectId(repo))}/merge_requests/${String(requestNumber(number))}/closes_issues`]),
  parseClosedByChangeRequest(stdout): ClosedIssue[] {
    const issues = parseValue(stdout, 'closing issues');
    if (!Array.isArray(issues)) throw new HostParseError('closing issues are not an array');
    return issues.map((entry) => {
      const issue = asObject(entry, 'closing issue');
      const where = typeof issue.web_url === 'string' ? ISSUE_PATH.exec(issue.web_url) : null;
      if (typeof issue.iid !== 'number' || !Number.isSafeInteger(issue.iid) || issue.iid < 1 || !where?.[1]) throw new HostParseError('closing issue has no iid or project');
      return { scope: where[1], key: String(issue.iid) };
    });
  },

  labels: (repo) => ({
    cli: 'glab',
    args: ['api', '--hostname', repo.host, '--paginate', '--output', 'ndjson', `projects/${String(projectId(repo))}/labels?per_page=100`],
    kind: 'read',
    class: 'read',
    host: repo.host,
  }),
  // One object per line; a project without labels prints nothing and exits 0 (recorded)
  parseLabels(stdout): TrackerLabel[] {
    return stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const label = asObject(parseValue(line, 'label'), 'label');
        if (typeof label.name !== 'string') throw new HostParseError('label has no name');
        return { name: label.name, color: typeof label.color === 'string' ? label.color : '', description: typeof label.description === 'string' ? label.description : '' };
      });
  },
};
