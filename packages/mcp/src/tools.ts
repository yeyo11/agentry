import type { ApiClient, Query } from './client.ts';
import { ApiError } from './client.ts';
import type { AgentryMcpToolName } from './names.ts';
import { boardRows, chatRows, documentRows, flowRunRows, journalRows, orchestrationRows, projectRows, providerRows, teamRows } from './fields.ts';
import type { Property, Schema } from './schema.ts';

export interface Tool {
  name: AgentryMcpToolName;
  description: string;
  inputSchema: Schema;
  run(args: Record<string, unknown>, api: ApiClient): Promise<unknown>;
}

export const str = (description: string, extra: Partial<Property> = {}): Property => ({ type: 'string', description, ...extra });
export const int = (description: string, minimum: number, maximum?: number): Property => ({
  type: 'integer',
  description,
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
export const schema = (properties: Record<string, Property>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const text = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
};
const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
};
export const need = (args: Record<string, unknown>, key: string): string => text(args, key) ?? '';
/** One path segment: an id or a key from the model must never reach past its own place in the path */
export const seg = (value: string): string => encodeURIComponent(value);

export const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PAGE_MAX = 50;
export const projectId = str('The project id, as list_projects gives it', { minLength: 1, maxLength: 200 });

const BOARD_FILTERS = ['status', 'type', 'priority', 'labels', 'assignee'] as const;

function pick(args: Record<string, unknown>, keys: readonly string[]): Query {
  const query: Query = {};
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number') query[key] = value;
  }
  return query;
}

export const TOOLS: readonly Tool[] = [
  {
    name: 'list_projects',
    description: 'Every project Agentry knows, with its key prefix and modules. Use it first to find a project id.',
    inputSchema: schema({}),
    run: async (_args, api) => projectRows(await api.get('/projects')),
  },
  {
    name: 'get_overview',
    description: "The dashboard in one call: what is running, waiting and failing across Agentry. Use it as the first look at 'how is everything'.",
    inputSchema: schema({}),
    run: (_args, api) => api.get('/overview'),
  },
  {
    name: 'get_board',
    description: "A board of work items by status, for one project or for all of them. Use it for 'what is in progress' or 'what is waiting for review'.",
    inputSchema: schema({
      projectId: str('The project id; leave it out for the board of every project', { minLength: 1, maxLength: 200 }),
      doneLimit: int('How many done cards to include', 0, PAGE_MAX),
      status: str('Comma separated statuses to keep'),
      type: str('Comma separated types to keep'),
      priority: str('Comma separated priorities to keep'),
      labels: str('Comma separated labels to keep'),
      assignee: str('Comma separated assignees to keep'),
      epicId: str('Only the items of this epic'),
      milestoneId: str('Only the items of this milestone'),
      q: str('Text to search in titles'),
    }),
    run: (args, api) => {
      const query = { ...pick(args, [...BOARD_FILTERS, 'epicId', 'milestoneId', 'q', 'doneLimit']) };
      const id = text(args, 'projectId');
      return api.get(id ? `/projects/${seg(id)}/work-items/board` : '/work-items/board', query).then(boardRows);
    },
  },
  {
    name: 'get_work_item',
    description: "One work item by key (AGN-12, any case) or id, with its comments, history, links and flow runs. Use it for 'how is X going'.",
    inputSchema: schema({ item: str('A key such as AGN-12, or an item id', { minLength: 1, maxLength: 200 }) }, ['item']),
    run: async (args, api) => {
      const item = need(args, 'item').trim();
      // The detail already carries the links; the runs are a route of their own
      const detail = await api.get(KEY.test(item) ? `/work-items/by-key/${seg(item.toUpperCase())}` : `/work-items/${seg(item)}`);
      const id = detail && typeof detail === 'object' && 'id' in detail && typeof detail.id === 'string' ? detail.id : item;
      const runs = await api.get(`/work-items/${seg(id)}/runs`);
      return { ...(detail as object), runs };
    },
  },
  {
    name: 'list_orchestrations',
    description: 'The orchestrations, newest first, with their state and cost. Use it to find an orchestration id.',
    inputSchema: schema({ limit: int('How many to return', 1, PAGE_MAX) }),
    run: async (args, api) => {
      const all = await api.get('/orchestrations');
      const limit = num(args, 'limit');
      return orchestrationRows(Array.isArray(all) && limit ? all.slice(0, limit) : all);
    },
  },
  {
    name: 'get_orchestration',
    description: "One orchestration with every task's state, result and cost, its verification and its final report. Use it for 'why did X fail'.",
    inputSchema: schema({ orchestrationId: str('The orchestration id', { minLength: 1, maxLength: 200 }) }, ['orchestrationId']),
    // The view carries the tasks, the verification and the final result: one route is enough
    run: (args, api) => api.get(`/orchestrations/${seg(need(args, 'orchestrationId'))}`),
  },
  {
    name: 'get_team',
    description: "A project's team: its agents, their roles and what each is doing. Use it for 'who works on this'.",
    inputSchema: schema({ projectId }, ['projectId']),
    run: async (args, api) => teamRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/team`)),
  },
  {
    name: 'list_flow_runs',
    description: "A project's flow runs, newest first, filtered by agent, role, status or item. Use it for 'what did the team do' or 'what failed'.",
    inputSchema: schema(
      {
        projectId,
        agent: str('Comma separated agents'),
        role: str('Comma separated roles'),
        status: str('Comma separated run statuses'),
        itemId: str('Only the runs of this work item id'),
        before: str('Only the runs before this date and time (ISO 8601)'),
        cursor: str('The nextCursor of the previous page, to read the next one'),
        limit: int('How many to return', 1, PAGE_MAX),
      },
      ['projectId'],
    ),
    run: async (args, api) => flowRunRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/flow/runs`, pick(args, ['agent', 'role', 'status', 'itemId', 'before', 'cursor', 'limit']))),
  },
  {
    name: 'get_journal',
    description: "A project's journal, newest first: what the team and people noted. Use it for 'what happened lately'.",
    inputSchema: schema({ projectId, limit: int('How many entries', 1, PAGE_MAX), before: str('Only entries before this cursor or date') }, ['projectId']),
    run: async (args, api) => journalRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/journal`, pick(args, ['limit', 'before']))),
  },
  {
    name: 'list_documents',
    description: "The tree of a project's documents. Use it to find the path of a document before read_document.",
    inputSchema: schema({ projectId }, ['projectId']),
    run: async (args, api) => documentRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/documents`)),
  },
  {
    name: 'read_document',
    description: "One document of a project by its path, as list_documents gives it. Use it to read a plan, a decision or a report.",
    inputSchema: schema({ projectId, path: str('The document path inside the project', { minLength: 1, maxLength: 1000 }) }, ['projectId', 'path']),
    run: (args, api) => api.get(`/projects/${seg(need(args, 'projectId'))}/documents/file`, { path: need(args, 'path') }),
  },
  {
    name: 'list_chats',
    description: "Chats, newest first, with their state. Use it for 'which chats are waiting for me' or 'what ran in project X'.",
    inputSchema: schema({
      project: str('Only the chats of this project id'),
      state: str('Only chats in this state', { enum: ['working', 'waiting', 'idle'] }),
      origin: str('Comma separated origins: agentry, external, orchestration, internal'),
      limit: int('How many chats', 1, PAGE_MAX),
    }),
    run: async (args, api) => chatRows(await api.get('/chats', pick(args, ['project', 'state', 'origin', 'limit']))),
  },
  {
    name: 'get_chat',
    description: "A chat's metadata, its last 20 transcript entries and what it waits on. Use it to see what a chat did or needs.",
    inputSchema: schema({ chatId: str('The chat id', { minLength: 1, maxLength: 200 }) }, ['chatId']),
    run: async (args, api) => {
      const id = seg(need(args, 'chatId'));
      const detail = await api.get(`/chats/${id}`, { limit: 20 });
      // A chat that does not use host prompts has none to list; that must not hide the chat
      const permissions = await api.get(`/chats/${id}/permissions`).catch((err: unknown) => (err instanceof ApiError && err.status !== null ? [] : Promise.reject(err)));
      return { ...(detail as object), permissions };
    },
  },
  {
    name: 'get_usage',
    description: "Cost and tokens for a range of days, with their breakdown by model and project. Use it for 'what did I spend'; the default is today.",
    inputSchema: schema({
      from: str('First day, YYYY-MM-DD', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      to: str('Last day, YYYY-MM-DD', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    }),
    run: async (args, api) => {
      const query = pick(args, ['from', 'to']);
      const [usage, breakdown] = await Promise.all([api.get('/usage', query), api.get('/usage/breakdown', query)]);
      return { usage, breakdown };
    },
  },
  {
    name: 'list_providers',
    description: "The agent providers (Claude Code, Codex, Gemini CLI, GitHub Copilot, OpenCode): whether each is ready and why not, its account, and its usage limit per window with the reset. Use it for 'how close am I to the limit' and 'which agents can I use'.",
    inputSchema: schema({}),
    // What the detector last read, never a new detection: refreshing runs every installed CLI
    run: async (_args, api) => providerRows(await api.get('/providers')),
  },
];
