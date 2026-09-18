import type { FastifyPluginAsync } from 'fastify';
import { parseMcpScope, parseVariant, RESOURCE_KINDS, type Core } from '@agentry/core';
import type { ResourceKind, WriteConfigFileRequest } from '@agentry/shared';

function parseKind(kind: string): ResourceKind {
  if (!RESOURCE_KINDS.includes(kind as ResourceKind)) throw new Error(`unknown resource kind '${kind}' (use ${RESOURCE_KINDS.join(', ')})`);
  return kind as ResourceKind;
}

/** Every route takes `?project=<projectId>`; without it the user scope is used. */
interface ScopeQuery {
  project?: string;
  variant?: string;
  scope?: string;
}

export const configRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // settings.json / settings.local.json
  app.get<{ Querystring: ScopeQuery }>('/config/settings', async (req) =>
    core.files.getSettings(await core.resolveScope(req.query.project), parseVariant(req.query.variant)),
  );
  app.put<{ Querystring: ScopeQuery; Body: { settings?: unknown } }>('/config/settings', async (req) =>
    core.files.setSettings(await core.resolveScope(req.query.project), parseVariant(req.query.variant), req.body?.settings),
  );

  // CLAUDE.md / CLAUDE.local.md
  app.get<{ Querystring: ScopeQuery }>('/config/instructions', async (req) =>
    core.files.getInstructions(await core.resolveScope(req.query.project), parseVariant(req.query.variant)),
  );
  app.put<{ Querystring: ScopeQuery; Body: { content?: unknown } }>('/config/instructions', async (req) =>
    core.files.setInstructions(await core.resolveScope(req.query.project), parseVariant(req.query.variant), req.body?.content),
  );

  // MCP servers (user / project / local)
  app.get<{ Querystring: ScopeQuery }>('/config/mcp', async (req) => core.mcp.list(await core.resolveScope(req.query.project)));
  app.get<{ Querystring: ScopeQuery }>('/config/mcp/health', async (req) => core.mcp.health(await core.resolveScope(req.query.project)));
  app.put<{ Params: { name: string }; Querystring: ScopeQuery; Body: { config?: unknown; scope?: unknown } }>(
    '/config/mcp/:name',
    async (req) => {
      const scope = await core.resolveScope(req.query.project);
      return core.mcp.upsert(scope, parseMcpScope(req.body?.scope, scope), req.params.name, req.body?.config);
    },
  );
  app.delete<{ Params: { name: string }; Querystring: ScopeQuery }>('/config/mcp/:name', async (req) => {
    const scope = await core.resolveScope(req.query.project);
    await core.mcp.remove(scope, parseMcpScope(req.query.scope, scope), req.params.name);
    return { ok: true };
  });

  // agents / skills / commands / output-styles / rules
  app.get<{ Params: { kind: string }; Querystring: ScopeQuery }>('/config/resources/:kind', async (req) =>
    core.resources.list(await core.resolveScope(req.query.project), parseKind(req.params.kind)),
  );
  app.get<{ Params: { kind: string; name: string }; Querystring: ScopeQuery }>('/config/resources/:kind/:name', async (req) => {
    const resource = await core.resources.get(await core.resolveScope(req.query.project), parseKind(req.params.kind), req.params.name);
    if (!resource) throw new Error('resource not found');
    return resource;
  });
  app.put<{ Params: { kind: string; name: string }; Querystring: ScopeQuery; Body: { content?: unknown } }>(
    '/config/resources/:kind/:name',
    async (req) =>
      core.resources.save(await core.resolveScope(req.query.project), parseKind(req.params.kind), req.params.name, req.body?.content),
  );
  app.delete<{ Params: { kind: string; name: string }; Querystring: ScopeQuery }>('/config/resources/:kind/:name', async (req) => {
    await core.resources.remove(await core.resolveScope(req.query.project), parseKind(req.params.kind), req.params.name);
    return { ok: true };
  });

  // Generic file explorer over a scope's Claude dir (`root` = 'user' or a project id)
  app.get('/config/files/roots', () => core.configFileRoots());
  app.get<{ Querystring: { root?: string } }>('/config/files/tree', async (req) => core.explorer.tree(await core.resolveScope(req.query.root)));
  app.get<{ Querystring: { root?: string; path?: string } }>('/config/files/content', async (req) =>
    core.explorer.read(await core.resolveScope(req.query.root), req.query.root || 'user', req.query.path ?? ''),
  );
  app.put<{ Body: WriteConfigFileRequest }>('/config/files/content', async (req) => {
    const { root, path, content, executable } = req.body ?? ({} as WriteConfigFileRequest);
    return core.explorer.write(await core.resolveScope(root), root || 'user', path ?? '', content, executable);
  });
  app.delete<{ Querystring: { root?: string; path?: string } }>('/config/files/content', async (req) => {
    await core.explorer.remove(await core.resolveScope(req.query.root), req.query.path ?? '');
    return { ok: true };
  });
};
