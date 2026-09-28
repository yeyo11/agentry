import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import { WorkItemError } from '@agentry/core';
import type { ApproveMemoryProposalRequest, CreateJournalEntryRequest, RejectMemoryProposalRequest } from '@agentry/shared';

// A missing body reaches core as an empty object, so its own validation names the field that is missing
const bodyOf = <T>(body: T | undefined): T => (body ?? {}) as T;

/**
 * A project's journal and the memory its team proposes. Reads need the project imported; a change
 * needs its Memory module on too. A proposal is only ever written to its target by `approve`: the
 * flow creates them, and nothing here can write one anywhere else.
 */
export const journalRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/projects/:id/journal', async (req) => {
    await core.memoryProject(req.params.id, 'read');
    return core.journal.page(req.params.id, req.query);
  });

  app.post<{ Params: { id: string }; Body: CreateJournalEntryRequest }>('/projects/:id/journal', async (req, reply) => {
    await core.memoryProject(req.params.id, 'write');
    const body = bodyOf(req.body);
    const itemId: unknown = body.itemId;
    if (itemId !== undefined && itemId !== null) {
      if (typeof itemId !== 'string') throw new WorkItemError('itemId must be the id of a work item', 400);
      // 400, as a relation to another project's item is: the journal is there, the body names the wrong item
      const item = core.workItems.find(itemId);
      if (!item || item.projectId !== req.params.id) throw new WorkItemError(`${itemId} is not a work item of this project`, 400);
    }
    return reply.status(201).send(core.journal.create(req.params.id, body));
  });

  app.delete<{ Params: { entryId: string } }>('/journal/:entryId', async (req) => {
    const entry = core.journal.find(req.params.entryId);
    if (!entry) throw new WorkItemError('journal entry not found', 404);
    await core.memoryProject(entry.projectId, 'write');
    core.journal.remove(entry.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/projects/:id/memory/proposals', async (req) => {
    await core.memoryProject(req.params.id, 'read');
    return core.memoryProposals.list(req.params.id, req.query.status);
  });

  app.post<{ Params: { proposalId: string }; Body: ApproveMemoryProposalRequest }>('/memory-proposals/:proposalId/approve', async (req) => {
    const proposal = core.memoryProposals.find(req.params.proposalId);
    if (!proposal) throw new WorkItemError('memory proposal not found', 404);
    await core.memoryProject(proposal.projectId, 'write');
    return core.memoryProposals.approve(proposal.id, bodyOf(req.body));
  });

  app.post<{ Params: { proposalId: string }; Body: RejectMemoryProposalRequest }>('/memory-proposals/:proposalId/reject', async (req) => {
    const proposal = core.memoryProposals.find(req.params.proposalId);
    if (!proposal) throw new WorkItemError('memory proposal not found', 404);
    await core.memoryProject(proposal.projectId, 'write');
    return core.memoryProposals.reject(proposal.id, bodyOf(req.body));
  });
};
