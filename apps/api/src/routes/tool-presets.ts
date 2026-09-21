import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';

/** The named tool sets a chat can be started or resumed with (`toolPreset` on the chat requests). */
export const toolPresetRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/config/tool-presets', () => core.toolPresets.overview());

  // Fastify prefers the static path over `/:id`, which is why `default` cannot be a preset id
  app.put<{ Body: unknown }>('/config/tool-presets/default', (req) => core.toolPresets.setDefault(req.body));

  app.post('/config/tool-presets/restore', () => core.toolPresets.restore());

  app.put<{ Params: { id: string }; Body: unknown }>('/config/tool-presets/:id', (req) => core.toolPresets.upsert(req.params.id, req.body));

  app.delete<{ Params: { id: string } }>('/config/tool-presets/:id', async (req) => {
    await core.toolPresets.remove(req.params.id);
    return { ok: true };
  });
};
