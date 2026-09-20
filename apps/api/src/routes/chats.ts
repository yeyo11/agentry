import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import { DEFAULT_ORIGINS } from '@agentry/core';
import type {
  CancelCommandRequest,
  ChatMessageRequest,
  ChatOrigin,
  ChatSettingsUpdate,
  ChatState,
  ForkChatRequest,
  HintRequest,
  NewChatRequest,
  PermissionDecision,
  PermissionMode,
  ResumeChatRequest,
  RunEvent,
  RunWorkflowRequest,
} from '@agentry/shared';

const HEARTBEAT_MS = 15_000;
const PERMISSION_MODES: readonly PermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const ORIGINS: readonly ChatOrigin[] = ['agentry', 'external', 'orchestration', 'internal'];
const STATES: readonly ChatState[] = ['working', 'waiting', 'idle'];

/** An optional non-negative integer query parameter. */
function count(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/** A comma-separated list of known values; anything else is a mistake worth saying so about. */
function listOf<T extends string>(value: string | undefined, known: readonly T[], name: string): T[] | undefined {
  if (value === undefined || value === '') return undefined;
  return value.split(',').map((item) => {
    const found = known.find((k) => k === item.trim());
    if (!found) throw new Error(`${name} must be one of ${known.join(', ')}`);
    return found;
  });
}

/** An optional calendar day, `YYYY-MM-DD`. */
function dayOf(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be a day as YYYY-MM-DD`);
  return value;
}

export const chatRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const { chats } = core;

  app.get<{ Querystring: { project?: string; loose?: string; origin?: string; state?: string; limit?: string } }>('/chats', (req) => {
    const { project, loose, origin, state, limit } = req.query;
    const [wanted] = listOf(state, STATES, 'state') ?? [];
    return chats.list({
      origins: listOf(origin, ORIGINS, 'origin') ?? DEFAULT_ORIGINS,
      ...(loose === '1' ? { project: null } : project ? { project } : {}),
      ...(wanted ? { state: wanted } : {}),
      ...(count(limit, 'limit') ? { limit: count(limit, 'limit') as number } : {}),
    });
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/usage', (req) => {
    const from = dayOf(req.query.from, 'from');
    const to = dayOf(req.query.to, 'to');
    return chats.usage({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  });

  app.post<{ Body: NewChatRequest }>('/chats', async (req, reply) => reply.status(201).send(await chats.create(req.body ?? ({} as NewChatRequest))));

  app.get<{ Params: { id: string }; Querystring: { sidechains?: string; limit?: string; before?: string } }>('/chats/:id', (req) =>
    chats.detail(req.params.id, {
      includeSidechains: req.query.sidechains === '1',
      ...(req.query.limit !== undefined ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.before !== undefined ? { before: Number(req.query.before) } : {}),
    }),
  );

  app.get<{ Params: { id: string }; Querystring: { q?: string; sidechains?: string } }>('/chats/:id/search', (req) =>
    chats.search(req.params.id, req.query.q ?? '', { includeSidechains: req.query.sidechains === '1' }),
  );

  app.post<{ Params: { id: string }; Body: ResumeChatRequest }>('/chats/:id/resume', (req) => chats.resume(req.params.id, req.body ?? ({} as ResumeChatRequest)));

  app.post<{ Params: { id: string }; Body: ForkChatRequest }>('/chats/:id/fork', async (req, reply) =>
    reply.status(201).send(await chats.fork(req.params.id, req.body ?? ({} as ForkChatRequest))),
  );

  app.post<{ Params: { id: string }; Body: ChatMessageRequest }>('/chats/:id/messages', (req) =>
    chats.send(req.params.id, {
      text: req.body?.text ?? '',
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
    }),
  );

  app.post<{ Params: { id: string } }>('/chats/:id/stop', (req) => chats.stop(req.params.id));

  app.post<{ Params: { id: string } }>('/chats/:id/interrupt', (req) => chats.interrupt(req.params.id));

  app.post<{ Params: { id: string }; Body: HintRequest }>('/chats/:id/hint', (req) => chats.hint(req.params.id, req.body ?? ({} as HintRequest)));

  app.post<{ Params: { id: string; toolUseId: string }; Body: CancelCommandRequest }>('/chats/:id/commands/:toolUseId/cancel', (req) =>
    chats.cancelCommand(req.params.id, req.params.toolUseId, req.body ?? {}),
  );

  app.patch<{ Params: { id: string }; Body: ChatSettingsUpdate }>('/chats/:id', (req) => {
    const { permissionMode, model } = req.body ?? {};
    if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) {
      throw new Error(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
    }
    if (model !== undefined && typeof model !== 'string') throw new Error('model must be a string');
    return chats.updateSettings(req.params.id, { permissionMode, model });
  });

  app.delete<{ Params: { id: string } }>('/chats/:id', async (req) => {
    await chats.remove(req.params.id);
    return { ok: true };
  });

  // Terminal output of a background session, which the CLI keeps and the transcripts do not.
  app.get<{ Params: { id: string } }>('/chats/:id/logs', async (req) => ({ logs: await chats.logs(req.params.id) }));

  // Server-Sent Events: replays buffered events after `since`, then streams live ones.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>('/chats/:id/stream', (req, reply) => {
    if (!chats.streams(req.params.id)) throw new Error('chat not found');
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
    const unsubscribe = chats.subscribe(req.params.id, write);
    for (const event of chats.events(req.params.id, lastEventId)) write(event);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // What the CLI is holding until someone decides: tool calls, questions, plans. The chat's event
  // stream carries a notice when one arrives, so the UI does not have to poll to notice it.
  app.get<{ Params: { id: string } }>('/chats/:id/permissions', (req) => core.permissions.list(req.params.id));

  app.post<{ Params: { id: string; requestId: string }; Body: PermissionDecision }>('/chats/:id/permissions/:requestId', (req) => {
    const { behavior, message, updatedInput, updatedPermissions } = req.body ?? ({} as PermissionDecision);
    if (behavior !== 'allow' && behavior !== 'deny') throw new Error("behavior must be 'allow' or 'deny'");
    if (updatedPermissions !== undefined && !Array.isArray(updatedPermissions)) throw new Error('updatedPermissions must be an array');
    return core.permissions.answer(req.params.requestId, { behavior, message, updatedInput, updatedPermissions });
  });

  // Branches of a chat: what it delegated, read from its stream while it runs and from the files
  // the CLI writes beside its transcript otherwise, so a chat started from a terminal has them too.
  app.get<{ Params: { id: string } }>('/chats/:id/subagents', (req) => chats.subagents(req.params.id));

  app.get<{ Params: { id: string } }>('/chats/:id/tasks', (req) => chats.backgroundTasks(req.params.id));

  app.get<{ Params: { id: string } }>('/chats/:id/workflows', (req) => chats.workflows(req.params.id));

  app.get<{ Params: { id: string; taskId: string }; Querystring: { offset?: string } }>('/chats/:id/tasks/:taskId/output', (req) =>
    chats.taskOutput(req.params.id, req.params.taskId, { offset: count(req.query.offset, 'offset') }),
  );

  // A subagent's whole conversation, from the transcript the CLI keeps for it beside the chat's.
  app.get<{ Params: { id: string; agentId: string }; Querystring: { after?: string } }>('/chats/:id/subagents/:agentId', async (req) => {
    const detail = await chats.agentTranscript(req.params.id, req.params.agentId, { after: count(req.query.after, 'after') });
    if (!detail) throw new Error('subagent not found');
    return detail;
  });

  // The same for an agent a workflow launched, which the CLI files under the workflow's own id.
  app.get<{ Params: { id: string; workflowId: string; agentId: string }; Querystring: { after?: string } }>(
    '/chats/:id/workflows/:workflowId/agents/:agentId',
    async (req) => {
      const detail = await chats.agentTranscript(req.params.id, req.params.agentId, {
        workflowId: req.params.workflowId,
        after: count(req.query.after, 'after'),
      });
      if (!detail) throw new Error('workflow agent not found');
      return detail;
    },
  );

  // What Claude actually loaded (tools, MCP, agents, skills, plugins…) per directory, from the latest chat started there
  app.get<{ Querystring: { cwd?: string } }>('/environments', (req) => {
    const all = [...core.runtime.environments.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    return req.query.cwd ? all.filter((e) => e.cwd === req.query.cwd) : all;
  });

  // The aggregates the inbox needs: a hung command is worth seeing wherever it is, whichever chat sent it.
  app.get('/tasks', () => chats.allBackgroundTasks());

  app.get('/subagents', () => chats.allSubagents());

  app.get('/workflows', () => chats.allWorkflows());

  app.get<{ Querystring: { cwd?: string } }>('/workflows/saved', (req) => core.workflowDefinitions(req.query.cwd || undefined));

  app.post<{ Body: RunWorkflowRequest }>('/workflows/saved/run', async (req, reply) =>
    reply.status(201).send(await core.runWorkflow(req.body ?? ({} as RunWorkflowRequest))),
  );
};
