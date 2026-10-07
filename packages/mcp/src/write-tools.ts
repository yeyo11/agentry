import type { ApiClient } from './client.ts';
import type { Property } from './schema.ts';
import { KEY, need, schema, seg, str, text, type Tool } from './tools.ts';

/**
 * The tools that change something. Each calls one route that already exists, with the chat's own token.
 * None is allowed ahead of time: the CLI asks the person before it runs any of them, so a call that is
 * denied never gets here. None deletes, stops, skips or restores, and none can widen what a chat may do.
 */

const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
const TYPES = ['epic', 'story', 'task', 'bug'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const item = str('A key such as AGN-12, or an item id', { minLength: 1, maxLength: 200 });
const labels: Property = { type: 'array', description: 'The labels, which replace the current ones', items: str('One label', { minLength: 1, maxLength: 100 }), maxItems: 50 };
const criteria = (description: string): Property => ({
  type: 'array',
  description,
  items: { type: 'object', description: 'One criterion', properties: { text: str('What must hold', { minLength: 1, maxLength: 1000 }) }, required: ['text'], additionalProperties: false },
  maxItems: 50,
});

/** What identifies a result, and nothing of the rest: the model needs the key, the id and where it stands */
const KEEP = ['id', 'key', 'title', 'name', 'status', 'state', 'outcome', 'type', 'priority', 'chatId', 'runId', 'orchestrationId', 'taskId', 'projectId'];
export function identify(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of KEEP) if (typeof source[key] === 'string' || typeof source[key] === 'number') out[key] = source[key];
  for (const nested of ['item', 'column']) if (source[nested] && typeof source[nested] === 'object') out[nested] = identify(source[nested]);
  return out;
}

/** The id behind an item reference: a key goes through the by-key route, an id is used as it is */
async function itemId(api: ApiClient, ref: string): Promise<string> {
  const value = ref.trim();
  if (!KEY.test(value)) return value;
  const found = await api.get(`/work-items/by-key/${seg(value.toUpperCase())}`);
  const id = found && typeof found === 'object' && 'id' in found ? found.id : undefined;
  if (typeof id !== 'string') throw new Error(`no work item has the key ${value}`);
  return id;
}

/** The body without the fields that only name the target */
function without(args: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !names.includes(key)));
}

export const WRITE_TOOLS: readonly Tool[] = [
  {
    name: 'create_work_item',
    description: 'Creates a work item in a project, in the backlog unless a status is given.',
    inputSchema: schema(
      {
        projectId: str('The project id, as list_projects gives it', { minLength: 1, maxLength: 200 }),
        title: str('The title', { minLength: 1, maxLength: 500 }),
        type: str('The type; the default is task', { enum: TYPES }),
        description: str('The description, in Markdown', { maxLength: 50_000 }),
        status: str('The column; the default is backlog', { enum: STATUSES.filter((s) => s !== 'done') }),
        priority: str('The priority; the default is medium', { enum: PRIORITIES }),
        labels,
        epicId: str('The id of an epic of the same project', { minLength: 1, maxLength: 200 }),
        milestoneId: str('The id of a milestone of the same project', { minLength: 1, maxLength: 200 }),
        acceptanceCriteria: criteria('The acceptance checklist, in order'),
      },
      ['projectId', 'title'],
    ),
    run: async (args, api) => identify(await api.send('POST', `/projects/${seg(need(args, 'projectId'))}/work-items`, without(args, 'projectId'))),
  },
  {
    name: 'update_work_item',
    description: 'Changes the fields given of a work item; the status and the order change through move_work_item.',
    inputSchema: schema(
      {
        item,
        type: str('The new type', { enum: TYPES }),
        title: str('The new title', { minLength: 1, maxLength: 500 }),
        description: str('The new description, in Markdown', { maxLength: 50_000 }),
        priority: str('The new priority', { enum: PRIORITIES }),
        labels,
        epicId: str('The id of an epic of the same project', { minLength: 1, maxLength: 200 }),
        milestoneId: str('The id of a milestone of the same project', { minLength: 1, maxLength: 200 }),
        acceptanceCriteria: criteria('The whole checklist, which replaces the current one'),
      },
      ['item'],
    ),
    run: async (args, api) => identify(await api.send('PATCH', `/work-items/${seg(await itemId(api, need(args, 'item')))}`, without(args, 'item'))),
  },
  {
    name: 'move_work_item',
    description: 'Moves a work item to another column, which can start a team member when the flow is on for that column. A card is never moved to Done: the person does that.',
    inputSchema: schema(
      {
        item,
        status: str('The column to move to', { enum: STATUSES }),
        afterId: str('The id of the card it goes right after in that column; leave it out to put it last', { minLength: 1, maxLength: 200 }),
      },
      ['item', 'status'],
    ),
    run: async (args, api) => {
      // Checked before any request: only a person moves an item to Done (docs/team-and-flow.md)
      if (text(args, 'status') === 'done') throw new Error('a work item is not moved to Done by the assistant: tell the person to move the card to Done themselves');
      return identify(await api.send('POST', `/work-items/${seg(await itemId(api, need(args, 'item')))}/move`, without(args, 'item')));
    },
  },
  {
    name: 'comment_work_item',
    description: 'Adds a comment to a work item.',
    inputSchema: schema({ item, body: str('The comment, in Markdown', { minLength: 1, maxLength: 50_000 }) }, ['item', 'body']),
    run: async (args, api) => identify(await api.send('POST', `/work-items/${seg(await itemId(api, need(args, 'item')))}/comments`, without(args, 'item'))),
  },
  {
    name: 'retry_flow_run',
    description: 'Queues a new flow run for the work item of a run that failed.',
    inputSchema: schema({ runId: str('The flow run id, as list_flow_runs gives it', { minLength: 1, maxLength: 200 }) }, ['runId']),
    run: async (args, api) => identify(await api.send('POST', `/flow-runs/${seg(need(args, 'runId'))}/retry`)),
  },
  {
    name: 'retry_orchestration_task',
    description: 'Runs a failed task of an orchestration again.',
    inputSchema: schema(
      {
        orchestrationId: str('The orchestration id', { minLength: 1, maxLength: 200 }),
        taskId: str('The task id, as get_orchestration gives it', { minLength: 1, maxLength: 200 }),
      },
      ['orchestrationId', 'taskId'],
    ),
    run: async (args, api) => identify(await api.send('POST', `/orchestrations/${seg(need(args, 'orchestrationId'))}/tasks/${seg(need(args, 'taskId'))}/retry`)),
  },
  {
    name: 'start_chat',
    description: "Starts a new chat with a first prompt, in a project's directory when one is given. The chat gets the app's defaults, never more.",
    inputSchema: schema(
      {
        prompt: str('The first message', { minLength: 1, maxLength: 100_000 }),
        projectId: str('The project id the chat works in', { minLength: 1, maxLength: 200 }),
        model: str('The model, such as sonnet', { minLength: 1, maxLength: 200 }),
      },
      ['prompt'],
    ),
    run: async (args, api) => {
      const projectId = text(args, 'projectId');
      const project = projectId ? await api.get(`/projects/${seg(projectId)}`) : null;
      const cwd = project && typeof project === 'object' && 'path' in project && typeof project.path === 'string' ? project.path : undefined;
      // Only these three reach the route: no permission mode, tool list, preset, MCP, account or prompts, so one confirmed call cannot start a chat that is more than the defaults
      const body = { prompt: need(args, 'prompt'), ...(cwd ? { cwd } : {}), ...(text(args, 'model') ? { model: text(args, 'model') } : {}) };
      return identify(await api.send('POST', '/chats', body));
    },
  },
  {
    name: 'accept_assistant_proposal',
    description: "Accepts a pending proposal of the project assistant, which creates what it proposes (a team member, a resource or a work item).",
    inputSchema: schema({ proposalId: str('The proposal id', { minLength: 1, maxLength: 200 }) }, ['proposalId']),
    run: async (args, api) => identify(await api.send('POST', `/assistant/proposals/${seg(need(args, 'proposalId'))}/accept`)),
  },
  {
    name: 'discard_assistant_proposal',
    description: 'Discards a pending proposal of the project assistant; nothing is created.',
    inputSchema: schema({ proposalId: str('The proposal id', { minLength: 1, maxLength: 200 }) }, ['proposalId']),
    run: async (args, api) => identify(await api.send('POST', `/assistant/proposals/${seg(need(args, 'proposalId'))}/discard`)),
  },
];

