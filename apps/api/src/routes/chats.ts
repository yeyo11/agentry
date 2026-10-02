import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import { chatToMarkdown, DEFAULT_ORIGINS, exportFilename, parseChangeScope } from '@agentry/core';
import type {
  CancelCommandRequest,
  ChatMessageRequest,
  ChatOrigin,
  ChatSettingsUpdate,
  ChatState,
  ExportFormat,
  ForkChatRequest,
  HandoffPreview,
  HintRequest,
  MoveChatRequest,
  NewChatRequest,
  PermissionDecision,
  PermissionMode,
  ResumeChatRequest,
  RunEvent,
  RunWorkflowRequest,
  UsageBucket,
} from '@agentry/shared';
import { openStream } from '../sse.ts';
import { diffOptions, pathOf, type DiffQuery, type ScopeQuery } from './orchestrations.ts';

const PERMISSION_MODES: readonly PermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const ORIGINS: readonly ChatOrigin[] = ['agentry', 'external', 'orchestration', 'internal'];
const STATES: readonly ChatState[] = ['working', 'waiting', 'idle'];

/** An optional non-negative integer query parameter. Shared, so no route invents its own paging. */
export function count(value: string | undefined, name: string): number | undefined {
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

/** A day range from `from` and `to`, both optional and both checked. */
function rangeOf(query: { from?: string; to?: string }): { from?: string; to?: string } {
  const from = dayOf(query.from, 'from');
  const to = dayOf(query.to, 'to');
  if (from && to && from > to) throw new Error('from must not be after to');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/**
 * A new chat's body, checked for the fields that reach a path or the CLI's arguments as text: a
 * number or a list there crashed deep in the spawn, and the caller's mistake came back as a 500.
 */
function newChatBody(body: unknown): NewChatRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('the body must be a JSON object with a prompt');
  const fields = body as Record<string, unknown>;
  // Core says when neither a prompt nor an attachment was sent: a chat may open with a file alone
  for (const key of ['prompt', 'cwd', 'worktree', 'name', 'provider'] as const) {
    if (fields[key] !== undefined && fields[key] !== null && typeof fields[key] !== 'string') throw new Error(`${key} must be text`);
  }
  const { attachments } = fields;
  if (attachments !== undefined && attachments !== null && (!Array.isArray(attachments) || attachments.some((a) => typeof a !== 'string'))) {
    throw new Error('attachments must be a list of upload ids');
  }
  return body as NewChatRequest;
}

export const chatRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const { chats } = core;

  app.get<{ Querystring: { project?: string; loose?: string; origin?: string; workers?: string; state?: string; limit?: string } }>('/chats', (req) => {
    const { project, loose, origin, workers, state, limit } = req.query;
    if (workers !== undefined && workers !== '0' && workers !== '1') throw new Error('workers must be 0 or 1');
    const [wanted] = listOf(state, STATES, 'state') ?? [];
    return chats.list({
      origins: listOf(origin, ORIGINS, 'origin') ?? DEFAULT_ORIGINS,
      ...(loose === '1' ? { project: null } : project ? { project } : {}),
      ...(workers === '0' ? { workers: false } : {}),
      ...(wanted ? { state: wanted } : {}),
      ...(count(limit, 'limit') ? { limit: count(limit, 'limit') as number } : {}),
    });
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/usage', (req) => chats.usage(rangeOf(req.query)));

  app.get<{ Querystring: { bucket?: string; from?: string; to?: string } }>('/usage/series', (req) => {
    const bucket = req.query.bucket ?? 'day';
    if (bucket !== 'day' && bucket !== 'week') throw new Error('bucket must be day or week');
    return chats.usageSeries(bucket satisfies UsageBucket, rangeOf(req.query));
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/usage/breakdown', (req) => chats.usageBreakdown(rangeOf(req.query)));

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/chats/:id/export', async (req, reply) => {
    const format = req.query.format ?? 'markdown';
    if (format !== 'markdown' && format !== 'json') throw new Error('format must be markdown or json');
    const exported = await chats.export(req.params.id);
    const kind: ExportFormat = format;
    void reply.header('content-disposition', `attachment; filename="${exportFilename(exported.chat, kind)}"`);
    if (kind === 'json') return exported;
    return reply.type('text/markdown; charset=utf-8').send(chatToMarkdown(exported.chat, exported.entries));
  });

  app.post<{ Body: NewChatRequest }>('/chats', async (req, reply) => reply.status(201).send(await chats.create(newChatBody(req.body))));

  app.get<{ Params: { id: string }; Querystring: { sidechains?: string; limit?: string; before?: string } }>('/chats/:id', (req) =>
    chats.detail(req.params.id, {
      includeSidechains: req.query.sidechains === '1',
      ...(req.query.limit !== undefined ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.before !== undefined ? { before: Number(req.query.before) } : {}),
    }),
  );

  // What the chat changed on disk: a worktree's git changes, and the files its own tool calls wrote
  app.get<{ Params: { id: string }; Querystring: ScopeQuery }>('/chats/:id/changes', (req) => core.changes.chatChanges(req.params.id, parseChangeScope(req.query)));

  app.get<{ Params: { id: string }; Querystring: DiffQuery }>('/chats/:id/changes/diff', (req) =>
    core.changes.chatDiff(req.params.id, pathOf(req.query.path), diffOptions(req.query)),
  );

  // Every edit of the transcript, each with its patch and the sentence written before it
  app.get<{ Params: { id: string } }>('/chats/:id/changes/steps', (req) => core.changes.chatSteps(req.params.id));

  app.get<{ Params: { id: string } }>('/chats/:id/checklist', (req) => core.changes.chatChecklist(req.params.id));

  app.get<{ Params: { id: string }; Querystring: { q?: string; sidechains?: string } }>('/chats/:id/search', (req) =>
    chats.search(req.params.id, req.query.q ?? '', { includeSidechains: req.query.sidechains === '1' }),
  );

  app.post<{ Params: { id: string }; Body: ResumeChatRequest }>('/chats/:id/resume', (req) => chats.resume(req.params.id, req.body ?? ({} as ResumeChatRequest)));

  app.post<{ Params: { id: string }; Body: ForkChatRequest }>('/chats/:id/fork', async (req, reply) =>
    reply.status(201).send(await chats.fork(req.params.id, req.body ?? ({} as ForkChatRequest))),
  );

  // The handoff exactly as a move would send it, built here and sent nowhere
  app.get<{ Params: { id: string }; Querystring: { provider?: string; model?: string } }>('/chats/:id/handoff', (req): Promise<HandoffPreview> => {
    const { provider, model } = req.query;
    if (!provider) throw new Error('provider is required');
    return chats.handoff(req.params.id, provider, model || undefined);
  });

  // A person moves a chat that reached a limit to a new chat on another provider
  app.post<{ Params: { id: string }; Body: MoveChatRequest | undefined }>('/chats/:id/move', async (req, reply) => {
    const { provider, action, model } = req.body ?? ({} as Partial<MoveChatRequest>);
    if (typeof provider !== 'string' || provider === '') throw new Error('provider is required');
    if (action !== 'handoff' && action !== 'restart') throw new Error("action must be 'handoff' or 'restart'");
    if (model !== undefined && typeof model !== 'string') throw new Error('model must be a string');
    // Core closes a wait into the move and points the run or task it worked for at the new chat
    const { chat } = await core.moveChat(req.params.id, { provider, action, ...(model ? { model } : {}) });
    return reply.status(201).send(chat);
  });

  // A person chooses to wait for the reset instead of moving
  app.post<{ Params: { id: string } }>('/chats/:id/wait', (req, reply) => {
    if (!core.runtime.get(req.params.id)) throw new Error('chat not found');
    if (!core.runtime.atLimit(req.params.id)) throw Object.assign(new Error('this chat has not reached a limit'), { statusCode: 409 });
    const move = core.rotation.waitFor(req.params.id);
    if (!move) throw Object.assign(new Error('this chat is already waiting'), { statusCode: 409 });
    return reply.status(201).send(move);
  });

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

    const stream = openStream(req, reply);
    // Ephemeral `partial` events carry no SSE id, so Last-Event-ID always points at a stored event
    const write = (event: RunEvent) => stream.send(event, event.kind === 'partial' ? {} : { id: event.seq });

    // Subscribe before replaying so nothing is lost in between; the client dedupes by seq.
    stream.onClose(chats.subscribe(req.params.id, write));
    for (const event of chats.events(req.params.id, lastEventId)) write(event);
  });

  // What the CLI is holding until someone decides: tool calls, questions, plans. The chat's event
  // stream carries a notice when one arrives, so the UI does not have to poll to notice it.
  app.get<{ Params: { id: string } }>('/chats/:id/permissions', (req) => core.permissions.list(req.params.id));

  app.post<{ Params: { id: string; requestId: string }; Body: PermissionDecision }>('/chats/:id/permissions/:requestId', (req) => {
    const { behavior, message, updatedInput, updatedPermissions } = req.body ?? ({} as PermissionDecision);
    if (behavior !== 'allow' && behavior !== 'deny') throw new Error("behavior must be 'allow' or 'deny'");
    if (updatedPermissions !== undefined && !Array.isArray(updatedPermissions)) throw new Error('updatedPermissions must be an array');
    // Scoped to the chat in the path: the id alone would let any chat answer any pending request
    return core.permissions.answer(req.params.requestId, { behavior, message, updatedInput, updatedPermissions }, req.params.id);
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
