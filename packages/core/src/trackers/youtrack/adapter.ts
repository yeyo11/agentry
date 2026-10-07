import { HostParseError, type HostCall, type HostRepo } from '../../hosts/code-host.ts';
import { parseJson } from '../../hosts/json.ts';
import { ISSUES_PAGE_SIZE, TrackerInputError, type IssueRead, type TrackerAdapter } from '../tracker.ts';

// YouTrack through JetBrains' `youtrack-app` CLI: `rest request --path`, which calls YouTrack's
// documented REST API with the host and the token Agentry keeps (handed in the child's environment,
// never in argv). Every path, field and answer below is what youtrack-app 1.0.3 was recorded to
// take and print against YouTrack 2026.2 (recordings/youtrack-app/NOTES.md). The scope is the
// project's short name, and `scope.host` is the instance's address, which issue links are built on.
//
// A status is written by setting the `State` custom field (`POST /api/issues/<id>` with
// `customFields`), not through `/api/commands`: the command language reads `State Done tag x` as
// two commands, so a status name could smuggle another one in, and the field write answers with
// the issue as it is after the write. Exit codes are read only for 3 (token) and 4 (not found):
// the recordings show HTTP 400 answered with 2 or 4 depending on the message.

/** The fields every read asks for; `updated` is epoch milliseconds, `resolved` null while open */
const ISSUE_FIELDS = 'idReadable,id,summary,description,resolved,updated,project(shortName),tags(name),customFields(name,value(name))';

/** `AGP-12`: a project short name, a dash and the number; never anything that could be read as a flag or a path */
const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]{0,63})-([1-9]\d{0,9})$/;
/** A project short name as YouTrack allows it, for the scope */
const SHORT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const read = (scope: HostRepo, args: string[]): HostCall => ({ cli: 'youtrack-app', args, kind: 'read', class: 'read', host: scope.host });
const write = (scope: HostRepo, args: string[]): HostCall => ({ cli: 'youtrack-app', args, kind: 'write', class: 'write', host: scope.host });

/** The issue key as YouTrack prints it: the short name upper case. Throws `TrackerInputError` for anything else. */
export function youtrackKey(key: string): string {
  const match = ISSUE_KEY.exec(key.trim());
  if (!match?.[1] || !match[2]) throw new TrackerInputError(`"${key}" is not a YouTrack issue id such as PROJ-12`);
  return `${match[1].toUpperCase()}-${match[2]}`;
}

function shortName(scope: HostRepo): string {
  if (!SHORT_NAME.test(scope.path)) throw new TrackerInputError(`"${scope.path}" is not a YouTrack project short name`);
  return scope.path.toUpperCase();
}

/**
 * The query a page runs: the project, then the person's own query (YouTrack ANDs juxtaposed
 * terms), unresolved issues when it is empty, and a stable order so paging by `$skip` neither
 * skips nor repeats while nothing changes.
 */
export function youtrackQuery(scope: HostRepo, query: string): string {
  const own = query.trim();
  const terms = [`project: ${shortName(scope)}`, own === '' ? '#Unresolved' : own];
  if (!/\b(order|sort) by\s*:/i.test(own)) terms.push('order by: updated desc');
  return terms.join(' ');
}

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

/** The name of a single-value custom field (`State`, `Type`); null when the issue has none or it is empty */
function fieldName(fields: unknown, name: string): string | null {
  if (!Array.isArray(fields)) return null;
  for (const entry of fields) {
    if (typeof entry !== 'object' || entry === null) continue;
    const field = entry as Record<string, unknown>;
    if (field.name !== name) continue;
    const value = field.value;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const valueName = (value as Record<string, unknown>).name;
      return typeof valueName === 'string' ? valueName : null;
    }
    return null;
  }
  return null;
}

function issueOf(raw: unknown, what: string): IssueRead {
  const issue = asObject(raw, what);
  const { idReadable, id, summary, resolved, updated, tags } = issue;
  if (typeof idReadable !== 'string' || !ISSUE_KEY.test(idReadable)) throw new HostParseError(`${what} has no idReadable`);
  if (typeof summary !== 'string') throw new HostParseError(`${what} has no summary`);
  if (resolved !== null && resolved !== undefined && typeof resolved !== 'number') throw new HostParseError(`${what} has a resolved that is not a time`);
  const labels: string[] = [];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const name = typeof tag === 'object' && tag !== null ? (tag as Record<string, unknown>).name : undefined;
      if (typeof name === 'string') labels.push(name);
    }
  }
  return {
    key: idReadable,
    externalId: typeof id === 'string' ? id : null,
    title: summary,
    // Absent when the issue has none (recorded): the field is left out rather than null
    body: typeof issue.description === 'string' ? issue.description : '',
    // Resolved is YouTrack's own word for closed: a state marked resolved in the project's bundle
    state: typeof resolved === 'number' ? 'closed' : 'open',
    stateReason: null,
    labels,
    // The answer does not carry the instance's address: the access fills it in (`youtrackIssueUrl`)
    url: null,
    updatedAt: typeof updated === 'number' ? new Date(updated).toISOString() : null,
    closedByChangeRequests: [],
    status: fieldName(issue.customFields, 'State'),
    kind: fieldName(issue.customFields, 'Type'),
  };
}

export const youtrackAdapter: TrackerAdapter = {
  id: 'youtrack',
  host: null,
  cli: 'youtrack-app',
  namedStatuses: true,

  key: youtrackKey,

  list(scope, { query, page }) {
    if (!Number.isInteger(page) || page < 1) throw new TrackerInputError('the page starts at 1');
    const params = new URLSearchParams({ query: youtrackQuery(scope, query), fields: ISSUE_FIELDS, $top: String(ISSUES_PAGE_SIZE), $skip: String((page - 1) * ISSUES_PAGE_SIZE) });
    return read(scope, ['rest', 'request', '--path', `/api/issues?${params.toString()}`]);
  },
  parseList(stdout, { page }) {
    const all = parseValue(stdout, 'issue list');
    if (!Array.isArray(all)) throw new HostParseError('issue list is not an array');
    return { issues: all.map((entry) => issueOf(entry, 'issue list entry')), page, hasMore: all.length >= ISSUES_PAGE_SIZE };
  },

  get: (scope, key) => read(scope, ['rest', 'request', '--path', `/api/issues/${youtrackKey(key)}?fields=${ISSUE_FIELDS}`]),
  parseGet: (stdout) => issueOf(parseValue(stdout, 'issue'), 'issue'),

  writes: () => true,
  setStatus(scope, key, { name }) {
    if (name === null || name.trim() === '') return null;
    const body = JSON.stringify({ customFields: [{ name: 'State', $type: 'StateIssueCustomField', value: { name: name.trim() } }] });
    return write(scope, ['rest', 'request', '--method', 'POST', '--path', `/api/issues/${youtrackKey(key)}?fields=${ISSUE_FIELDS}`, '--body', body]);
  },
};

/** The issue's address on the instance, for a read whose answer does not carry it */
export function youtrackIssueUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/issue/${key}`;
}
