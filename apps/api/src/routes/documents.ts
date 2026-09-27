import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { TieDocumentRequest, WriteDocumentRequest } from '@agentry/shared';

/**
 * The Documents module: a project's documents folder and the documents tied to its work items.
 * The path travels in the query string rather than the URL's path, so a file in a subfolder is one
 * parameter and no router ever gets to normalise a `..` before the core refuses it.
 */
export const documentRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/projects/:id/documents', (req) => core.documents.tree(req.params.id));

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/projects/:id/documents/file', (req) =>
    core.documents.read(req.params.id, req.query.path),
  );

  app.put<{ Params: { id: string }; Querystring: { path?: string }; Body: WriteDocumentRequest }>('/projects/:id/documents/file', (req) =>
    core.documents.write(req.params.id, req.query.path, req.body ?? ({} as WriteDocumentRequest)),
  );

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>('/projects/:id/documents/file', async (req) => {
    await core.documents.remove(req.params.id, req.query.path);
    return { ok: true };
  });

  app.post<{ Params: { itemId: string }; Body: TieDocumentRequest }>('/work-items/:itemId/documents', async (req, reply) =>
    reply.status(201).send(await core.documents.tie(req.params.itemId, req.body ?? ({} as TieDocumentRequest))),
  );
};
