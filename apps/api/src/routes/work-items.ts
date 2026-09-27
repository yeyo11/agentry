import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
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

/** A filter as a query string carries it: every list comma separated. */
interface FilterQuery {
  status?: string;
  type?: string;
  priority?: string;
  labels?: string;
  assignee?: string;
  epicId?: string;
  milestoneId?: string;
  q?: string;
}

const csv = (value: string | undefined): string[] | undefined => {
  const items = value
    ?.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
};

/**
 * Refused rather than ignored: a filter on a status that does not exist would answer with an empty
 * board, which reads as "nothing to do" instead of "you asked for something else".
 */
function members<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T[] | undefined {
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
  return {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(priority ? { priority } : {}),
    ...(labels ? { labels } : {}),
    ...(assignee ? { assignee } : {}),
    ...(query.epicId ? { epicId: query.epicId } : {}),
    ...(query.milestoneId ? { milestoneId: query.milestoneId } : {}),
    ...(query.q?.trim() ? { q: query.q } : {}),
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
    return reply.status(201).send(core.workItems.link(req.params.itemId, bodyOf(req.body)));
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

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/changes', (req) => core.workItemChanges(req.params.itemId));

  app.get<{ Params: { itemId: string }; Querystring: { path?: string } }>('/work-items/:itemId/changes/diff', (req) => {
    if (!req.query.path) throw new Error('path is required');
    return core.workItemDiff(req.params.itemId, req.query.path);
  });

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
