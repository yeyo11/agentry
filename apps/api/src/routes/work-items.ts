import type { FastifyPluginAsync } from 'fastify';
import { parseChangeScope, type Core } from '@agentry/core';
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from '@agentry/shared';
import type {
  CheckAcceptanceCriterionRequest,
  CreateMilestoneRequest,
  CreateWorkItemCommentRequest,
  CreateWorkItemFromMessageRequest,
  CreateWorkItemLinkRequest,
  CreateWorkItemRelationRequest,
  CreateWorkItemRequest,
  MoveWorkItemRequest,
  OrchestrateWorkItemsRequest,
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

// A missing body reaches core as an empty object, so its own validation names the field that is missing
const bodyOf = <T>(body: T | undefined): T => (body ?? {}) as T;

/**
 * A project's board, its work items and its milestones. Every change is checked against the
 * project first: imported, with its Board module on. Reads only need the project imported, so a
 * board switched off still shows what it holds. The store writes the history and emits the events.
 */
export const workItemRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // ---- a project's collection

  app.get<{ Params: { id: string }; Querystring: FilterQuery }>('/projects/:id/work-items', async (req) => {
    await core.workItemProject(req.params.id, 'read');
    return core.workItems.list({ ...filterOf(req.query), projectId: req.params.id });
  });

  app.post<{ Params: { id: string }; Body: CreateWorkItemRequest }>('/projects/:id/work-items', async (req, reply) => {
    await core.workItemProject(req.params.id, 'write');
    return reply.status(201).send(core.workItems.create(req.params.id, bodyOf(req.body)));
  });

  app.get<{ Params: { id: string }; Querystring: FilterQuery }>('/projects/:id/work-items/board', async (req) => {
    await core.workItemProject(req.params.id, 'read');
    return core.workItems.board(req.params.id, filterOf(req.query));
  });

  // A draft to review, not a launched graph: `POST /orchestrations` launches it
  app.post<{ Params: { id: string }; Body: OrchestrateWorkItemsRequest }>('/projects/:id/work-items/orchestrate', (req) =>
    core.orchestrateWorkItems(req.params.id, bodyOf(req.body)),
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

  // Registered before `/work-items/:itemId`, which would otherwise take "board" for an id
  app.get<{ Querystring: FilterQuery }>('/work-items/board', (req) => core.allWorkItemsBoard(filterOf(req.query)));

  app.get<{ Querystring: FilterQuery }>('/work-items', (req) => core.allWorkItems(filterOf(req.query)));

  // ---- one item

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId', (req) => core.workItemDetail(req.params.itemId));

  app.patch<{ Params: { itemId: string }; Body: UpdateWorkItemRequest }>('/work-items/:itemId', async (req) => {
    await core.workItemAccess(req.params.itemId, 'write');
    return core.workItems.update(req.params.itemId, bodyOf(req.body));
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

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/history', async (req) => {
    await core.workItemAccess(req.params.itemId, 'read');
    return core.workItems.history(req.params.itemId);
  });

  // ---- what works on an item

  app.post<{ Params: { itemId: string }; Body: WorkOnWorkItemRequest }>('/work-items/:itemId/work', async (req, reply) =>
    reply.status(201).send(await core.workOnItem(req.params.itemId, bodyOf(req.body))),
  );

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
