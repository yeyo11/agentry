import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Orchestration, Project, WorkItem } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../../../apps/api/src/app.ts';
import { createClient, type FetchLike } from '../src/client.ts';
import { createServer } from '../src/server.ts';

export interface Seeded {
  app: FastifyInstance;
  core: Core;
  project: Project;
  item: WorkItem;
  orchestration: Orchestration;
  /** Calls the tools of the server against the real API, in process */
  call(name: string, args?: unknown): Promise<{ isError: boolean; text: string; json: unknown }>;
  close(): Promise<void>;
}

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

/** `fetch` backed by `app.inject`, so the client's own code runs against the real routes */
export function injectFetch(app: FastifyInstance, seen: Array<{ url: string; headers: Record<string, string>; method: string }> = []): FetchLike {
  return async (url, init) => {
    seen.push({ url, headers: init.headers, method: init.method });
    const { pathname, search } = new URL(url);
    const res = await app.inject({ method: init.method as 'GET', url: pathname + search, headers: init.headers });
    return { status: res.statusCode, text: async () => res.body };
  };
}

/** A wrapper on a temporary data dir with project Shop (AGN), item AGN-1, an orchestration and a flow run */
export async function seed(): Promise<Seeded> {
  const root = mkdtempSync(join(tmpdir(), 'agentry-mcp-test-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const dir = join(root, 'shop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Shop\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'plan.md'), '# Shop plan\n');
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name: 'Shop', modules: ['board'] }) });
  const project = imported.json<Project>();
  const created = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/work-items`,
    ...json({ title: 'Cart loses items', type: 'bug', status: 'todo', description: 'Items vanish on reload' }),
  });
  const item = created.json<WorkItem>();
  const orch = await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ name: 'review', cwd: dir, tasks: [{ id: 'a', name: 'a', prompt: 'do it' }] }) });
  const orchestration = orch.json<Orchestration>();
  const raw = new DatabaseSync(join(root, 'data', 'wrapper.db'));
  raw
    .prepare(
      `INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, outcome, error, queued_at)
       VALUES ('run-1', ?, ?, 'developer', 'developer', 'sonnet', 'work', 'in_progress', 'ended', 'done', NULL, '2026-09-28T00:00:00Z')`,
    )
    .run(project.id, item.id);
  raw.close();

  const server = createServer({ api: createClient({ baseUrl: 'http://wrapper.test/api', fetch: injectFetch(app) }), version: 'test' });
  let n = 0;
  return {
    app,
    core,
    project,
    item,
    orchestration,
    async call(name, args = {}) {
      const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }));
      const result = (JSON.parse(line ?? 'null') as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      const text = result.content[0]?.text ?? '';
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // an error message or a truncated result
      }
      return { isError: result.isError, text, json: parsed };
    },
    async close() {
      await app.close();
      core.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
