import type { FastifyPluginAsync } from 'fastify';
import { parseChangeScope, WorkItemError, type Core } from '@agentry/core';
import { agentryLanguage, WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from '@agentry/shared';
import type {
  CheckAcceptanceCriterionRequest,
  CreateMilestoneRequest,
  CreateWorkItemCommentRequest,
  CreateWorkItemFromMessageRequest,
  CreateWorkItemLinkRequest,
  CreateWorkItemRelationRequest,
  CreateWorkItemRequest,
  LinkWorkItemIssueRequest,
  MoveWorkItemRequest,
  OrchestrateWorkItemsRequest,
  TrackerId,
  TriageWorkItemRequest,
  TriageWorkItemResult,
  UpdateMilestoneRequest,
  UpdateWorkItemRequest,
  WorkItemFilter,
  WorkOnWorkItemRequest,
} from '@agentry/shared';
import { diffOptions, pathOf, type DiffQuery, type ScopeQuery } from './orchestrations.ts';

/**
 * A filter as a query string carries it: every list comma separated, or its parameter repeated
 * (`status=todo&status=done`), which a query string parser hands over as an array.
 */
type Param = string | string[] | undefined;
interface FilterQuery {
  status?: Param;
  type?: Param;
  priority?: Param;
  labels?: Param;
  assignee?: Param;
  epicId?: Param;
  milestoneId?: Param;
  q?: Param;
}

interface PageQuery extends FilterQuery {
  limit?: Param;
  cursor?: Param;
}

interface BoardQueryString extends FilterQuery {
  doneLimit?: Param;
}

const csv = (value: Param): string[] | undefined => {
  const items = (Array.isArray(value) ? value : [value])
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    .map((v) => v.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};

/** A parameter that takes one value: repeated, it would have to pick one, so it is refused. */
function single(value: Param, field: string): string | undefined {
  if (Array.isArray(value)) throw new Error(`${field} is given more than once`);
  return value;
}

/**
 * Refused rather than ignored: a filter on a status that does not exist would answer with an empty
 * board, which reads as "nothing to do" instead of "you asked for something else".
 */
function members<T extends string>(value: Param, allowed: readonly T[], field: string): T[] | undefined {
  const items = csv(value);
  for (const item of items ?? []) if (!(allowed as readonly string[]).includes(item)) throw new Error(`unknown ${field}: ${item}`);
  return items as T[] | undefined;
}

function filterOf(query: FilterQuery): Omit<WorkItemFilter, 'projectId'> {
  const status = members(query.status, WORK_ITEM_STATUSES, 'status');
  const type = members(query.type, WORK_ITEM_TYPES, 'type');
  const priority = members(query.priority, WORK_ITEM_PRIORITIES, 'priority');
  const labels = csv(query.labels);
  const assignee = csv(query.assignee);
  const epicId = single(query.epicId, 'epicId');
  const milestoneId = single(query.milestoneId, 'milestoneId');
  const q = single(query.q, 'q');
  return {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(priority ? { priority } : {}),
    ...(labels ? { labels } : {}),
    ...(assignee ? { assignee } : {}),
    ...(epicId ? { epicId } : {}),
    ...(milestoneId ? { milestoneId } : {}),
    ...(q?.trim() ? { q } : {}),
  };
}

/**
 * A count in a query string. Anything but digits is refused here, since `Number('')` and
 * `Number('1e2')` would read as counts; the store checks the range.
 */
function count(value: Param, field: string): number | undefined {
  const text = single(value, field);
  if (text === undefined) return undefined;
  if (!/^\d{1,9}$/.test(text)) throw new WorkItemError(`${field} must be a whole number`, 400);
  return Number(text);
}

function pageOf(query: PageQuery): { limit?: number; cursor?: string } {
  const limit = count(query.limit, 'limit');
  const cursor = single(query.cursor, 'cursor');
  return { ...(limit === undefined ? {} : { limit }), ...(cursor ? { cursor } : {}) };
}

function boardOf(query: BoardQueryString): { doneLimit?: number } {
  const doneLimit = count(query.doneLimit, 'doneLimit');
  return doneLimit === undefined ? {} : { doneLimit };
}

// A missing body reaches core as an empty object, so its own validation names the field that is missing
const bodyOf = <T>(body: T | undefined): T => (body ?? {}) as T;

/**
 * The tracker an issue key belongs to on an item. A key is a number on GitHub and on GitLab, so the
 * same one can sit under two trackers; `?tracker=` names which, and is only needed then.
 */
function issueTracker(core: Core, itemId: string, key: string, named: string | undefined): TrackerId {
  const held = core.workItems.issuesOf(itemId).filter((i) => i.key === key && (named === undefined || i.tracker === named));
  const [first, ...more] = held;
  if (!first) throw new WorkItemError('the item is not linked to that issue', 404);
  if (more.length) throw new WorkItemError('that key is linked under more than one tracker: add ?tracker= to say which', 400);
  return first.tracker;
}

/**
 * A project's board, its work items and its milestones. Every change is checked against the
 * project first: imported, with its Board module on. Reads only need the project imported, so a
 * board switched off still shows what it holds. The store writes the history and emits the events.
 */
export const workItemRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // ---- a project's collection

  // Cards, as every list: an item's description is read on its own page
  app.get<{ Params: { id: string }; Querystring: FilterQuery }>('/projects/:id/work-items', async (req) => {
    await core.workItemProject(req.params.id, 'read');
    return core.workItems.cards({ ...filterOf(req.query), projectId: req.params.id });
  });

  app.get<{ Params: { id: string }; Querystring: PageQuery }>('/projects/:id/work-items/page', async (req) => {
    await core.workItemProject(req.params.id, 'read');
    return core.workItems.page({ ...filterOf(req.query), projectId: req.params.id }, pageOf(req.query));
  });

  app.post<{ Params: { id: string }; Body: CreateWorkItemRequest }>('/projects/:id/work-items', async (req, reply) => {
    await core.workItemProject(req.params.id, 'write');
    return reply.status(201).send(core.workItems.create(req.params.id, bodyOf(req.body)));
  });

  // `board.triage` for a draft being typed: a prefill for the form and a duplicate warning, or null
  app.post<{ Params: { id: string }; Body: TriageWorkItemRequest }>('/projects/:id/work-items/triage', async (req): Promise<TriageWorkItemResult> => {
    await core.workItemProject(req.params.id, 'write');
    const { title, description } = bodyOf(req.body);
    if (typeof title !== 'string' || title.trim() === '') throw new Error('title must be a non-empty string');
    if (description !== undefined && typeof description !== 'string') throw new Error('description must be a string');
    return { triage: await core.workItems.triage(req.params.id, { title, ...(description === undefined ? {} : { description }) }) };
  });

  app.get<{ Params: { id: string }; Querystring: BoardQueryString }>('/projects/:id/work-items/board', async (req) => {
    return core.workItemBoard(req.params.id, filterOf(req.query), boardOf(req.query));
  });

  // A draft to review, not a launched graph: `POST /orchestrations` launches it. Its objective is
  // written in the language the person reads Agentry in, which the web sends
  app.post<{ Params: { id: string }; Body: OrchestrateWorkItemsRequest }>('/projects/:id/work-items/orchestrate', (req) =>
    core.orchestrateWorkItems(req.params.id, bodyOf(req.body), agentryLanguage(req.headers['accept-language'])),
  );

  app.get<{ Params: { id: string } }>('/projects/:id/milestones', async (req) => {
    await core.workItemProject(req.params.id, 'read');
    return core.workItems.milestones(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: CreateMilestoneRequest }>('/projects/:id/milestones', async (req, reply) => {
    await core.workItemProject(req.params.id, 'write');
    return reply.status(201).send(core.workItems.createMilestone(req.params.id, bodyOf(req.body)));
  });

  // ---- every project

  // Beside `/work-items/:itemId`: a static segment wins over the parameter, so "board", "page" and
  // "by-key" are never taken for an id
  app.get<{ Querystring: BoardQueryString }>('/work-items/board', (req) => core.allWorkItemsBoard(filterOf(req.query), boardOf(req.query)));

  app.get<{ Querystring: FilterQuery }>('/work-items', (req) => core.allWorkItems(filterOf(req.query)));

  app.get<{ Querystring: PageQuery }>('/work-items/page', (req) => core.allWorkItemsPage(filterOf(req.query), pageOf(req.query)));

  app.get<{ Params: { key: string } }>('/work-items/by-key/:key', (req) => core.workItemByKey(req.params.key));

  // ---- one item

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId', (req) => core.workItemDetail(req.params.itemId));

  app.patch<{ Params: { itemId: string }; Body: UpdateWorkItemRequest }>('/work-items/:itemId', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    const body = bodyOf(req.body);
    // Answered 200 with the status unchanged, it read as a move that worked
    for (const field of ['status', 'afterId'] as const) {
      if (body && typeof body === 'object' && field in body) throw new WorkItemError(`${field} is changed with POST /work-items/{itemId}/move, not PATCH`, 400);
    }
    return core.workItems.update(req.params.itemId, body);
  });

  app.delete<{ Params: { itemId: string } }>('/work-items/:itemId', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    core.workItems.remove(req.params.itemId);
    return { ok: true };
  });

  app.post<{ Params: { itemId: string }; Body: MoveWorkItemRequest }>('/work-items/:itemId/move', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    return core.workItems.move(req.params.itemId, bodyOf(req.body));
  });

  app.patch<{ Params: { itemId: string; criterionId: string }; Body: CheckAcceptanceCriterionRequest }>(
    '/work-items/:itemId/criteria/:criterionId',
    async (req) => {
      await core.workItemAccess(req.params.itemId, 'write');
      return core.workItems.checkCriterion(req.params.itemId, req.params.criterionId, bodyOf(req.body));
    },
  );

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/comments', async (req) => {
    await core.workItemAccess(req.params.itemId, 'read');
    return core.workItems.comments(req.params.itemId);
  });

  app.post<{ Params: { itemId: string }; Body: CreateWorkItemCommentRequest }>('/work-items/:itemId/comments', async (req, reply) => {
    await core.workItemAccess(req.params.itemId, 'write');
    return reply.status(201).send(core.workItems.comment(req.params.itemId, bodyOf(req.body)));
  });

  app.post<{ Params: { itemId: string }; Body: CreateWorkItemRelationRequest }>('/work-items/:itemId/relations', async (req, reply) => {
    await core.workItemAccess(req.params.itemId, 'write');
    return reply.status(201).send(core.workItems.relate(req.params.itemId, bodyOf(req.body)));
  });

  app.delete<{ Params: { itemId: string; otherId: string } }>('/work-items/:itemId/relations/:otherId', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    return core.workItems.unrelate(req.params.itemId, req.params.otherId);
  });

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/links', (req) => core.workItemLinks(req.params.itemId));

  app.post<{ Params: { itemId: string }; Body: CreateWorkItemLinkRequest }>('/work-items/:itemId/links', async (req, reply) => {
    await core.workItemAccess(req.params.itemId, 'write');
    const { kind, role, chatId, orchestrationId, taskId, documentPath } = bodyOf(req.body);
    // A document goes through the Documents module, which knows the project's folder and refuses a
    // path outside it; the store alone only checks the path's shape
    if (kind === 'document') {
      return reply.status(201).send(await core.documents.tie(req.params.itemId, { path: documentPath ?? '' }, { role, chatId: chatId ?? null }));
    }
    return reply.status(201).send(await core.linkWorkItem(req.params.itemId, { kind, role, chatId, orchestrationId, taskId, documentPath }));
  });

  app.delete<{ Params: { itemId: string; linkId: string } }>('/work-items/:itemId/links/:linkId', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    // The link is named under its item, so an id from another item is not found here
    if (!core.workItems.links(req.params.itemId).some((l) => l.id === req.params.linkId)) throw new Error('link not found');
    core.workItems.unlink(req.params.linkId);
    return { ok: true };
  });

  // ---- tracker issues

  // The issue is read from the project's tracker first: a key that is not there links nothing
  app.post<{ Params: { itemId: string }; Body: LinkWorkItemIssueRequest }>('/work-items/:itemId/issues', async (req, reply) => {
    await core.workItemAccess(req.params.itemId, 'write');
    const key = bodyOf(req.body).key;
    if (typeof key !== 'string' || key.trim() === '') throw new WorkItemError('key must name an issue', 400);
    return reply.status(201).send(await core.trackerImport.link(req.params.itemId, key.trim()));
  });

  app.delete<{ Params: { itemId: string; key: string }; Querystring: { tracker?: string } }>('/work-items/:itemId/issues/:key', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    return core.workItems.unlinkIssue(req.params.itemId, issueTracker(core, req.params.itemId, req.params.key, req.query.tracker), req.params.key);
  });

  // One more write to the tracker, for what the item's column asks; the person's click, never retried by Agentry
  app.post<{ Params: { itemId: string; key: string }; Querystring: { tracker?: string } }>('/work-items/:itemId/issues/:key/sync', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    return core.trackerSync.syncAgain(req.params.itemId, issueTracker(core, req.params.itemId, req.params.key, req.query.tracker), req.params.key);
  });

  // A chat is named by its title when the history is read, not when the link was written
  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/history', (req) => core.workItemHistory(req.params.itemId));

  // ---- what works on an item

  app.post<{ Params: { itemId: string }; Body: WorkOnWorkItemRequest }>('/work-items/:itemId/work', async (req, reply) =>
    reply.status(201).send(await core.workOnItem(req.params.itemId, bodyOf(req.body))),
  );

  // The person's approval: 202 while the branch is updated, pushed and proposed in the background,
  // 200 with the PR that is open already
  app.post<{ Params: { itemId: string } }>('/work-items/:itemId/pull-request', async (req, reply) => {
    const { status, item, pullRequest } = await core.approveWorkItem(req.params.itemId);
    return reply.status(status).send({ item, pullRequest });
  });

  app.post<{ Params: { itemId: string } }>('/work-items/:itemId/pull-request/refresh', (req) => core.refreshWorkItemPullRequest(req.params.itemId));

  // Scoped and with its context as a chat's or a task's, so the review screen reads an item the same way
  app.get<{ Params: { itemId: string }; Querystring: ScopeQuery }>('/work-items/:itemId/changes', (req) =>
    core.workItemChanges(req.params.itemId, parseChangeScope(req.query)),
  );

  app.get<{ Params: { itemId: string }; Querystring: DiffQuery }>('/work-items/:itemId/changes/diff', (req) =>
    core.workItemDiff(req.params.itemId, pathOf(req.query.path), diffOptions(req.query)),
  );

  app.post<{ Params: { id: string }; Body: CreateWorkItemFromMessageRequest }>('/chats/:id/work-items', async (req, reply) =>
    reply.status(201).send(await core.workItemFromMessage(req.params.id, bodyOf(req.body))),
  );

  app.get<{ Params: { id: string } }>('/chats/:id/work-items', (req) => core.workItemsOfChat(req.params.id));

  // ---- one milestone

  app.get<{ Params: { milestoneId: string } }>('/milestones/:milestoneId', (req) => core.milestoneAccess(req.params.milestoneId, 'read'));

  app.patch<{ Params: { milestoneId: string }; Body: UpdateMilestoneRequest }>('/milestones/:milestoneId', async (req) => {
    await core.milestoneAccess(req.params.milestoneId, 'write');
    return core.workItems.updateMilestone(req.params.milestoneId, bodyOf(req.body));
  });

  app.delete<{ Params: { milestoneId: string } }>('/milestones/:milestoneId', async (req) => {
    await core.milestoneAccess(req.params.milestoneId, 'write');
    core.workItems.deleteMilestone(req.params.milestoneId);
    return { ok: true };
  });
};
