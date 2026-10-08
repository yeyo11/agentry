import { entryText, isModelName, type PolicyPart, type RunOutcome, type ToolPolicy } from '@agentry/shared';
import { isAgentryMcpWriteTool } from '@agentry/mcp';
import { LEGACY_PROVIDER } from './chat-records.ts';
import { commandKind } from './commands.ts';
import { judge, type NeutralRequest } from './policy-judge.ts';
import { now, type ChatHost, type LiveChat } from './live-chat.ts';
import type { DriverEvent, SessionInit } from './providers/driver.ts';

/** The next `seq` of a chat's stored entries; read once from the table, so a resumed chat carries on after what an earlier process wrote */
const entrySeq = new WeakMap<LiveChat, number>();

/**
 * Records what a non-Claude chat streamed as rows, the transcript of a provider that keeps none
 * Agentry can read. Claude's own JSONL is its transcript, so it is not copied.
 */
export function recordEntry(host: ChatHost, chat: LiveChat, entry: Extract<DriverEvent, { kind: 'message' }>['entry']): void {
  if (chat.driver.manifest.id === LEGACY_PROVIDER) return;
  try {
    const seq = entrySeq.get(chat) ?? (host.db.chatEntries(chat.id).at(-1)?.seq ?? -1) + 1;
    host.db.appendChatEntries(chat.id, [{ seq, at: entry.timestamp || now(), entry }]);
    entrySeq.set(chat, seq + 1);
  } catch {
    // the transcript only loses this entry; the chat goes on
  }
}

const IDLE_TIMEOUT_MS = Number(process.env.AGENTRY_IDLE_TIMEOUT_MS ?? 10 * 60_000);

/**
 * Folds what a driver reports into the chat it belongs to: the settings, the ticker, the history of
 * commands, the executions and the feed. Whatever the agent's protocol looked like, this is all
 * `ChatManager` knows of it.
 */
export function foldEvent(host: ChatHost, chat: LiveChat, event: DriverEvent): void {
  switch (event.kind) {
    case 'init': {
      // The session exists now: a respawn resumes it, and a fork is no longer waiting to be made
      chat.created = true;
      chat.forkFrom = null;
      if (chat.driver.sessionIds === 'assigned') {
        // The agent names the session. The first id is recorded; another one later would point the
        // chat at a different conversation without anyone noticing, so it fails the execution
        const native = event.nativeSessionId ?? event.sessionId;
        if (native && chat.nativeId && native !== chat.nativeId) {
          host.failProtocol(chat, `The agent reported session ${native} for a chat bound to ${chat.nativeId}; refusing to rebind it.`);
          return;
        }
        if (native && !chat.nativeId) {
          chat.nativeId = native;
          host.persist();
        }
      } else if (event.sessionId && event.sessionId !== chat.id) {
        // The id was Agentry's to choose, and the agent takes it; if it ever answered otherwise, the
        // chat would be one row on disk and another here, so say so where the person can see it
        chat.push({ kind: 'notice', text: `The CLI reported session ${event.sessionId} for the chat ${chat.id}; its transcript is not where this chat expects it.` });
      }
      // What the alias this process was started with stands for now: the cache of models labels
      // none of the aliases, and this is the one place it says which model one is
      try {
        host.modelIds.record(chat.opts.model, event.model);
      } catch {
        // the picker only goes on showing the alias alone
      }
      chat.setSettings({
        ...(event.permissionMode ? { permissionMode: event.permissionMode } : {}),
        ...(event.model ? { model: event.model } : {}),
      });
      if (event.cwd) {
        chat.workingDir = event.cwd;
        chat.activity.setCwd(event.cwd);
      }
      const environment = { cwd: chat.cwd, observedAt: now(), chatId: chat.id, ...event.environment };
      host.environments.set(chat.cwd, environment);
      try {
        host.db.saveEnvironment(environment);
      } catch {
        // the panel only loses this directory until its next run
      }
      chat.push(event.run);
      // What the first event confirms about the installed agent: Core hands it to the detector
      host.emit('chat-init', chat.provider, {
        version: event.environment.cliVersion ?? null,
        tools: event.environment.tools ?? [],
        mcpServers: (event.environment.mcpServers ?? []).map((s) => ({ name: s.name, status: s.status })),
        structuredOutput: chat.opts.jsonSchema !== undefined,
      } satisfies SessionInit);
      return;
    }

    case 'mode-changed':
      chat.setSettings({ permissionMode: event.mode });
      chat.updatedAt = now();
      return;

    case 'block-started':
      // The ticker reacts to the block, not to the message that closes it: a tool call is named
      // here, seconds before its arguments have finished streaming
      chat.activity.blockStarted(event.block, now());
      chat.partial = event.streams === 'other' ? null : { block: event.streams, text: '' };
      chat.structured = event.structured ? '' : null;
      return;

    case 'structured-delta':
      chat.structured = (chat.structured ?? '') + event.json;
      host.emit('chat-structured', chat.id, chat.structured);
      return;

    case 'delta':
      if (!chat.partial) return;
      chat.partial.text += event.text;
      chat.emitPartial();
      return;

    case 'block-stopped':
      chat.activity.blockStopped();
      chat.partial = null;
      chat.structured = null;
      return;

    case 'stop-reason':
      chat.stopReason = event.reason;
      return;

    // Kept for the health of the chat and not pushed as an event: it says a command is alive and
    // how long it has run, which no transcript view needs and which would fill the buffer
    case 'heartbeat':
      if (event.toolUseId && event.elapsedSeconds !== null) chat.heartbeats.set(event.toolUseId, { elapsedSeconds: event.elapsedSeconds, at: now() });
      chat.activityAt = now();
      return;

    // Notes how long each shell command took, by kind, once its result arrives: the history that
    // "far longer than usual" is measured against. A command a person cancelled is recorded as such,
    // and one that failed is too: neither says how long the command takes when it works.
    case 'command-started': {
      const kind = commandKind(event.command);
      if (kind) chat.openCommands.set(event.toolUseId, { command: event.command, kind, startedAt: now() });
      return;
    }
    case 'command-ended': {
      chat.heartbeats.delete(event.toolUseId);
      const open = chat.openCommands.get(event.toolUseId);
      if (!open) return;
      chat.openCommands.delete(event.toolUseId);
      const outcome = chat.cancelled.delete(event.toolUseId) ? 'cancelled' : event.isError ? 'error' : 'ok';
      try {
        host.db.recordCommand({ kind: open.kind, chatId: chat.id, toolUseId: event.toolUseId, startedAt: open.startedAt, durationMs: Date.now() - Date.parse(open.startedAt), outcome });
      } catch {
        // the history only loses one run of a command
      }
      return;
    }

    case 'message': {
      const { entry } = event;
      trackActivity(chat, entry);
      recordEntry(host, chat, entry);
      // The agent can start a turn on its own (e.g. after a background task notification)
      if (entry.role === 'assistant' && chat.status === 'idle') {
        if (chat.idleTimer) clearTimeout(chat.idleTimer);
        chat.setStatus('busy');
      }
      if (event.mainAgent) {
        if (event.stopReason !== undefined) chat.stopReason = event.stopReason;
        const text = entryText(entry);
        if (text) chat.lastText = text.slice(0, 2000);
        // A slash command's reply comes from `<synthetic>`, which a resume would pass back as `--model`
        if (isModelName(entry.model)) chat.setSettings({ model: entry.model });
      }
      chat.push(event.run);
      return;
    }

    case 'task':
      chat.push(event.run);
      return;

    case 'failed':
      host.failProtocol(chat, event.reason);
      return;

    case 'rate-limit':
      if (event.info.status === 'rejected') chat.rateLimited = true;
      host.observeLimit(chat, event);
      return;

    case 'rate-limited':
      chat.rateLimited = true;
      host.observeLimit(chat, event);
      return;

    case 'permission-request':
      askPermission(host, chat, event.question);
      return;

    // The agent withdrew the question: the broker settles it, and the answer that was waiting is dropped
    case 'permission-withdrawn':
      host.permissions?.withdraw(event.id);
      return;

    case 'result':
      foldResult(host, chat, event);
      return;

    case 'stderr':
      chat.push({ kind: 'stderr', text: event.text });
      return;

    case 'unreadable':
      chat.push({ kind: 'other', text: event.text });
      return;

    case 'notice':
      chat.push({ kind: 'notice', text: event.text });
      return;
  }
}

function foldResult(host: ChatHost, chat: LiveChat, event: Extract<DriverEvent, { kind: 'result' }>): void {
  const execution = chat.execution;
  if (execution) {
    execution.turns += event.turns;
    // The agent's total is over its process, so per execution it only ever grows
    if (event.costUsd !== undefined) execution.costUsd = Math.max(execution.costUsd ?? 0, event.costUsd);
    host.learnModelCosts(execution, event.modelUsage);
  }
  host.learnWindows(event.modelUsage);
  if (event.rateLimited) {
    chat.rateLimited = true;
    host.observeLimit(chat, event);
  }
  const { isError } = event;
  const cause = !isError ? undefined : chat.interruptRequested || chat.stopRequested ? 'stopped' : event.budget ? 'budget' : chat.rateLimited ? 'rate-limit' : undefined;
  const stopReason = event.stopReason ?? chat.stopReason;
  // The next turn's reason is its own
  chat.stopReason = null;
  chat.lastResult = { isError, result: event.text, structuredOutput: event.structuredOutput, costUsd: chat.costUsd, ...(cause ? { cause } : {}), ...(stopReason ? { stopReason } : {}) };
  // An interrupted turn ends as an error by the agent's own count, but nothing went wrong
  if (isError && !chat.interruptRequested) chat.error = event.failure;
  chat.interruptRequested = false;
  chat.activity.turnEnded();
  host.persist();
  chat.push({ ...event.run, outcome: { ...(event.run.outcome as RunOutcome), ...(cause ? { cause } : {}), ...(stopReason ? { stopReason } : {}) } });
  // Every result, where waitForResult only hands out the first: a chat continued by hand keeps
  // producing them, and whoever the chat works for has to hear about each
  host.emit('chat-result', chat.id, chat.lastResult);
  if (chat.opts.keepAlive === false) {
    chat.session?.endInput();
  } else {
    chat.setStatus('idle');
    chat.idleTimer = setTimeout(() => chat.session?.endInput(), IDLE_TIMEOUT_MS);
    chat.idleTimer.unref();
  }
  host.maybeLimit(chat);
}

/** The parts of a policy a request falls under; a driver lists in `host` the ones it leaves to the judge. */
function partsOf(request: NeutralRequest): PolicyPart[] {
  switch (request.kind) {
    case 'command':
      return ['commands', 'gitPush'];
    case 'edit':
      return ['edit'];
    case 'read':
      return ['read'];
    case 'fetch':
      return ['network'];
    case 'delegate':
      return ['delegate'];
    case 'other':
      return [];
  }
}

function hostJudges(chat: LiveChat, policy: ToolPolicy, request: NeutralRequest): boolean {
  const host = chat.driver.translatePolicy(policy).host;
  return !!host && partsOf(request).some((part) => host.includes(part));
}

/** The agent asks the host something: a tool permission, a question, a plan to approve. */
function askPermission(host: ChatHost, chat: LiveChat, question: Extract<DriverEvent, { kind: 'permission-request' }>['question']): void {
  const session = chat.session;
  const broker = host.permissions;
  const policy = chat.opts.toolConfig?.policy;
  if (policy && question.request && hostJudges(chat, policy, question.request)) {
    // Decided by Agentry's policy, not by the agent's own rules: the part is listed as `host`
    const verdict = judge(policy, question.request);
    if (verdict !== 'ask') {
      const allowed = verdict === 'allow';
      chat.push({ kind: 'notice', text: `${allowed ? 'Allowed' : 'Denied'} by the chat's policy: ${question.toolName}`, data: { toolUseId: question.toolUseId, verdict } });
      session?.answerPermission(question.id, allowed ? { behavior: 'allow' } : { behavior: 'deny', message: "Denied by the chat's tool policy" });
      return;
    }
  }
  if (!broker || chat.opts.permissionPrompts !== 'host') {
    session?.answerPermission(question.id, { behavior: 'deny', message: 'Nobody is answering permission prompts for this chat' });
    return;
  }
  const isWrite = isAgentryMcpWriteTool(question.toolName);
  chat.pendingPrompts++;
  chat.activity.setPendingPrompts(chat.pendingPrompts, now());
  void broker
    .ask({
      id: question.id,
      runId: chat.id,
      toolName: question.toolName,
      toolUseId: question.toolUseId,
      input: question.input,
      requestedAt: now(),
      ...(question.description !== undefined ? { description: question.description } : {}),
      // No "always allow" for a write of Agentry's own: each one is confirmed on its own, every time
      ...(question.suggestions && !isWrite ? { suggestions: question.suggestions } : {}),
      ...(question.requiresUserInteraction ? { requiresUserInteraction: true } : {}),
    })
    .then((decision) => {
      chat.pendingPrompts = Math.max(0, chat.pendingPrompts - 1);
      chat.activity.setPendingPrompts(chat.pendingPrompts, now());
      host.noteActivity(chat);
      // Withdrawn by the agent, or the process is gone: nobody is waiting for an answer
      if (!decision) return;
      // An allow cannot carry rules either, so a later write is never allowed without asking
      if (isWrite && decision.behavior === 'allow') {
        const { updatedPermissions: _rules, ...once } = decision;
        session?.answerPermission(question.id, once);
        return;
      }
      session?.answerPermission(question.id, decision);
    });
}

/**
 * Feeds the ticker the calls of the main agent and their results. A sidechain entry belongs to a
 * subagent: what the chat is doing is the call that started it, which stays open until the
 * subagent reports back.
 */
function trackActivity(chat: LiveChat, entry: Extract<DriverEvent, { kind: 'message' }>['entry']): void {
  if (entry.isSidechain) return;
  for (const block of entry.blocks) {
    if (block.type === 'tool_use') {
      chat.activity.called(block.id, block.name, (block.input ?? {}) as Record<string, unknown>, entry.timestamp || now());
    } else if (block.type === 'tool_result') {
      chat.activity.answered(block.toolUseId);
    }
  }
}
