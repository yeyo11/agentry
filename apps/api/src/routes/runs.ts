import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { RunDetail, RunEvent, RunOptions } from '@agentry/shared';

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

  app.post<{ Params: { id: string }; Body: { text?: string } }>('/runs/:id/messages', (req) =>
    core.runs.send(req.params.id, req.body?.text ?? ''),
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

  app.get('/tasks', () =>
    core.runs
      .list()
      .flatMap((r) => r.backgroundTasks)
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt)),
  );

  app.get('/subagents', () =>
    core.runs
      .list()
      .flatMap((r) => r.subagents)
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt)),
  );
};
