import type { FastifyPluginAsync } from 'fastify';
import { DOCUMENT_CONTENT_MAX, type Core } from '@agentry/core';
import type { TieDocumentRequest, WriteDocumentRequest } from '@agentry/shared';

/**
 * What a document's largest content weighs once written as a JSON string: an escaped control
 * character takes six bytes, so the core's own limit (answered with a clear 400) is always reached
 * before this one (a bare 413)
 */
const WRITE_BODY_LIMIT = DOCUMENT_CONTENT_MAX * 6 + 64 * 1024;

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

  app.put<{ Params: { id: string }; Querystring: { path?: string }; Body: WriteDocumentRequest }>('/projects/:id/documents/file', { bodyLimit: WRITE_BODY_LIMIT }, (req) =>
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
