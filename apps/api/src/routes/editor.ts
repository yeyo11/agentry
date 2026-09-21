import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/** Where the UI's file links open: kept on the server so every browser of a person agrees. */
export const editorRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/settings/editor', () => core.editor.get());

  app.put<{ Body: unknown }>('/settings/editor', (req) => core.editor.set(req.body));
};
