import { HostParseError, type HostCall, type HostRepo } from '../../hosts/code-host.ts';
import { parseJson } from '../../hosts/json.ts';
import {
  issueNumber,
  ISSUES_PAGE_SIZE,
  requestNumber,
  TrackerInputError,
  type ClosedIssue,
  type IssueRead,
  type HostTrackerAdapter,
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

/** The project path of an issue's `web_url`: `https://host/group/sub/project/-/work_items/12` */
const ISSUE_PATH = /^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/\d+$/;

function projectId(repo: HostRepo): number {
  if (repo.projectId === undefined) throw new TrackerInputError('the labels list is read on the numeric project id, which this repository does not have yet');
  return repo.projectId;
}

const closeIssue = (repo: HostRepo, key: string): HostCall => write(repo, ['issue', 'close', String(issueNumber(key)), '-R', projectUrl(repo)]);

export const gitlabIssuesAdapter: HostTrackerAdapter = {
  id: 'gitlab-issues',
  host: 'gitlab',
  cli: 'glab',
  namedStatuses: false,

  key: (key) => String(issueNumber(key)),

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

  writes: (column) => column === 'done',
  setStatus: (repo, key, { column }) => (column === 'done' ? closeIssue(repo, key) : null),
  // Idempotent: closing a closed issue exits 0 (recorded)
  close: closeIssue,

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

};
