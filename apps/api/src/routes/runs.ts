import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { PermissionDecision, RunDetail, RunEvent, RunOptions } from '@agentry/shared';

const HEARTBEAT_MS = 15_000;

export const runRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/runs', () => core.runs.list());

  app.post<{ Body: RunOptions }>('/runs', async (req, reply) => {
    const run = core.runs.start(req.body ?? ({} as RunOptions));
    return reply.status(201).send(run);
  });

  app.get<{ Params: { id: string } }>('/runs/:id', (req): RunDetail => {
    const run = core.runs.get(req.params.id);
    if (!run) throw new Error('run not found');
    return { run, events: core.runs.events(run.id) };
  });

  app.post<{ Params: { id: string }; Body: { text?: string; attachments?: string[] } }>('/runs/:id/messages', (req) =>
    core.runs.send(req.params.id, req.body?.text ?? '', Array.isArray(req.body?.attachments) ? req.body.attachments : []),
  );

  app.post<{ Params: { id: string } }>('/runs/:id/stop', (req) => core.runs.stop(req.params.id));

  app.delete<{ Params: { id: string } }>('/runs/:id', (req) => {
    if (!core.runs.get(req.params.id)) throw new Error('run not found');
    if (!core.runs.remove(req.params.id)) throw new Error('run is still alive; stop it first');
    return { ok: true };
  });

  // Server-Sent Events: replays buffered events after `since`, then streams live ones.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>('/runs/:id/stream', (req, reply) => {
    const run = core.runs.get(req.params.id);
    if (!run) throw new Error('run not found');
    const lastEventId = Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // hijacked replies bypass @fastify/cors
      ...(process.env.AGENTRY_CORS_ORIGIN && req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin } : {}),
    });
    // Ephemeral `partial` events carry no SSE id, so Last-Event-ID always points at a stored event
    const write = (event: RunEvent) =>
      reply.raw.write(`${event.kind === 'partial' ? '' : `id: ${event.seq}\n`}data: ${JSON.stringify(event)}\n\n`);

    // Subscribe before replaying so nothing is lost in between; the client dedupes by seq.
    const unsubscribe = core.runs.subscribe(run.id, write);
    for (const event of core.runs.events(run.id, lastEventId)) write(event);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // What Claude actually loaded (tools, MCP, agents, skills, plugins…) per directory, from the latest run there
  app.get<{ Querystring: { cwd?: string } }>('/environments', (req) => {
    const all = [...core.runs.environments.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    return req.query.cwd ? all.filter((e) => e.cwd === req.query.cwd) : all;
  });

  // Runs report from their live stream; sessions started from a terminal, and runs that have ended,
  // from their files on disk. Core decides which, so every screen reads the same list.
  app.get('/tasks', () => core.allBackgroundTasks());

  // Tool calls the CLI is holding until someone decides. The run's event stream carries a notice
  // when one arrives, so the UI does not have to poll to notice it.
  app.get<{ Params: { id: string } }>('/runs/:id/permissions', (req) => core.permissions.list(req.params.id));

  app.post<{ Params: { id: string; requestId: string }; Body: PermissionDecision }>(
    '/runs/:id/permissions/:requestId',
    (req) => {
      const { behavior, message, updatedInput } = req.body ?? ({} as PermissionDecision);
      if (behavior !== 'allow' && behavior !== 'deny') throw new Error("behavior must be 'allow' or 'deny'");
      return core.permissions.answer(req.params.requestId, { behavior, message, updatedInput });
    },
  );

  app.get('/subagents', () => core.allSubagents());
};
