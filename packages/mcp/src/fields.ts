/**
 * What each list tool keeps of the route's answer: the fields a model needs to choose, and the id
 * that fetches the rest. The REST payloads carry what a screen draws (worktrees, environments,
 * token splits), which is most of their weight and none of what picks a row.
 */

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const objs = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : []);

/** The listed keys that are present; absent ones and nulls are left out, which costs a model nothing */
function pick(source: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

const keyOf = (ref: unknown): string | undefined => (isObj(ref) && typeof ref.key === 'string' ? ref.key : undefined);

/** A list the route did not answer in the shape expected goes through untouched rather than being emptied */
const shaped = (value: unknown, shape: (v: unknown) => unknown): unknown => (Array.isArray(value) || isObj(value) ? shape(value) : value);

export const projectRows = (value: unknown): unknown =>
  Array.isArray(value) ? objs(value).map((p) => pick(p, ['id', 'name', 'key', 'path', 'modules', 'chatCount', 'lastActivity', 'exists'])) : value;

export const boardRows = (value: unknown): unknown =>
  shaped(value, (board) => {
    if (!isObj(board) || !Array.isArray(board.columns)) return board;
    return {
      ...pick(board, ['projectId']),
      columns: objs(board.columns).map((column) => ({
        ...pick(column, ['status', 'count', 'limit', 'overLimit', 'more']),
        items: objs(column.items).map((item) => ({
          ...pick(item, ['key', 'id', 'type', 'title', 'status', 'priority', 'labels', 'hasDescription', 'waiting']),
          ...(isObj(item.assignee) ? { assignee: item.assignee.role ?? item.assignee.kind } : {}),
          ...(keyOf(item.epic) ? { epic: keyOf(item.epic) } : {}),
        })),
      })),
    };
  });

export const orchestrationRows = (value: unknown): unknown =>
  Array.isArray(value)
    ? objs(value).map((o) => {
        const tasks = objs(o.tasks);
        const byStatus: Record<string, number> = {};
        for (const task of tasks) if (typeof task.status === 'string') byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
        return {
          ...pick(o, ['id', 'name', 'status', 'createdAt', 'endedAt', 'costUsd', 'cwd', 'error']),
          tasks: { total: tasks.length, ...byStatus },
          ...(isObj(o.verification) && o.verification.status !== undefined ? { verification: o.verification.status } : {}),
        };
      })
    : value;

export const teamRows = (value: unknown): unknown =>
  shaped(value, (team) => {
    if (!isObj(team) || !Array.isArray(team.members)) return team;
    return {
      ...pick(team, ['projectId', 'enabled']),
      members: objs(team.members).map((m) => ({
        ...pick(m, ['agent', 'role', 'model', 'responsibility', 'columns', 'queued']),
        running: objs(m.running).map((r) => ({ run: r.id, item: keyOf(r.item) })),
        ...(isObj(m.lastRun) ? { lastRun: { run: m.lastRun.id, item: keyOf(m.lastRun.item), outcome: m.lastRun.outcome } } : {}),
      })),
    };
  });

export const flowRunRows = (value: unknown): unknown =>
  shaped(value, (page) => {
    if (!isObj(page) || !Array.isArray(page.runs)) return page;
    return {
      runs: objs(page.runs).map((r) => ({
        ...pick(r, ['id', 'role', 'agent', 'model', 'step', 'state', 'outcome', 'summary', 'error', 'chatId', 'queuedAt', 'endedAt']),
        ...(keyOf(r.item) ? { item: keyOf(r.item) } : {}),
      })),
      ...pick(page, ['total', 'nextCursor']),
    };
  });

export const journalRows = (value: unknown): unknown =>
  shaped(value, (page) => {
    if (!isObj(page) || !Array.isArray(page.entries)) return page;
    return {
      entries: objs(page.entries).map((e) => ({
        ...pick(e, ['id', 'kind', 'text', 'documentPath', 'createdAt']),
        ...(keyOf(e.item) ? { item: keyOf(e.item) } : {}),
        ...(isObj(e.author) ? { author: e.author.role ?? e.author.kind } : {}),
      })),
      ...pick(page, ['total', 'nextBefore']),
    };
  });

function documentRow(node: Obj): Obj {
  return {
    ...pick(node, ['path', 'type', 'title', 'fileCount']),
    ...(Array.isArray(node.children) ? { children: objs(node.children).map(documentRow) } : {}),
  };
}

export const documentRows = (value: unknown): unknown =>
  shaped(value, (docs) => {
    if (!isObj(docs) || !Array.isArray(docs.tree)) return docs;
    return { ...pick(docs, ['root', 'exists', 'fileCount']), tree: objs(docs.tree).map(documentRow) };
  });

export const chatRows = (value: unknown): unknown =>
  Array.isArray(value)
    ? objs(value).map((c) => ({
        ...pick(c, ['id', 'title', 'state', 'origin', 'model', 'messageCount', 'updatedAt', 'atLimit']),
        ...(isObj(c.project) ? { project: c.project.name, projectId: c.project.id } : {}),
        ...(isObj(c.orchestration) ? { orchestration: c.orchestration.id } : {}),
        ...(isObj(c.cost) && typeof c.cost.usd === 'number' ? { costUsd: c.cost.usd } : {}),
      }))
    : value;

export const providerRows = (value: unknown): unknown =>
  Array.isArray(value)
    ? objs(value).map((p) => ({
        ...pick(p, ['id', 'label', 'state', 'reason', 'account', 'version']),
        ...(isObj(p.limit) ? { limit: pick(p.limit, ['state', 'window', 'utilization', 'resetsAt']) } : {}),
      }))
    : value;
