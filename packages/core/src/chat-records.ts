import type { ChatFork, ChatOrigin, ChatToolConfig, Execution, PermissionMode } from '@agentry/shared';
import { executionOutcome } from './chat-model.ts';
import { emptyTokenUsage } from './usage.ts';

/**
 * What Agentry itself knows about a chat that the CLI's transcript does not say: where it came
 * from, what it was called, how its executions were set up. One row per chat; the transcript stays
 * the CLI's, and a chat Agentry never drove has no record at all.
 */
export interface ChatRecord {
  /** The session id */
  id: string;
  name: string;
  /** Where its processes start: the project directory, not the worktree the CLI moves into */
  cwd: string;
  /** Where the CLI says it works, when that is somewhere else */
  workingDir: string | null;
  origin: ChatOrigin;
  orchestrationId: string | null;
  orchestrationTaskId: string | null;
  derivedFrom: ChatFork | null;
  /** The first message Agentry sent, for a chat whose transcript has no readable one */
  prompt: string;
  lastText: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  /** Pinned claude-swap account, when it did not use the active one */
  account: string | null;
  /** Where permissions, questions and plans go, kept so a resumed execution asks the same way */
  permissionPrompts: 'host' | 'none';
  /** The tool preset and MCP servers it was started with; a process that resumes it is given them again */
  tools?: ChatToolConfig | null;
  createdAt: string;
  updatedAt: string;
}

/** A chat with its history, as the store holds it. */
export interface StoredChat {
  record: ChatRecord;
  executions: Execution[];
}

/**
 * The shape one run had before a run became an execution of a chat: one record per `start()`, even
 * when it resumed a conversation, with the session id assigned along the way. Kept only to read
 * what an older wrapper wrote, once, at startup.
 */
export interface LegacyRun {
  id: string;
  name: string;
  sessionId: string | null;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  status: 'starting' | 'busy' | 'idle' | 'completed' | 'failed' | 'stopped';
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  turns: number;
  costUsd: number;
  prompt: string;
  lastText: string | null;
  error: string | null;
  orchestrationId: string | null;
  orchestrationTaskId: string | null;
  internal: boolean;
  account: string | null;
  workingDir?: string | null;
  permissionPrompts?: 'host' | 'none';
}

export interface ConvertedRuns {
  chats: StoredChat[];
  /** Old run id → the chat (session id) it became, for the documents that pointed at a run */
  chatOf: Map<string, string>;
}

/**
 * Folds the runs an older wrapper stored into chats: every run of one session becomes an execution
 * of the one chat that session is. A run that never got a session id started nothing (the spawn
 * failed before the CLI answered) and leaves no chat.
 */
export function chatsFromRuns(runs: readonly LegacyRun[]): ConvertedRuns {
  const bySession = new Map<string, LegacyRun[]>();
  const chatOf = new Map<string, string>();
  for (const run of runs) {
    if (!run.sessionId) continue;
    chatOf.set(run.id, run.sessionId);
    const list = bySession.get(run.sessionId) ?? [];
    list.push(run);
    bySession.set(run.sessionId, list);
  }
  const chats: StoredChat[] = [];
  for (const [id, list] of bySession) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) continue;
    const executions: Execution[] = list.map((run) => {
      // A run alive when the wrapper went away has no process any more and nobody stopped it
      const outcome = executionOutcome(run.status, true);
      return {
        id: run.id,
        startedAt: run.createdAt,
        endedAt: run.endedAt ?? run.updatedAt,
        outcome,
        error: run.error,
        permissionMode: run.permissionMode,
        model: run.model,
        account: run.account,
        maxBudgetUsd: null,
        // A run that answered nothing has no figure; one that did has the CLI's own
        costUsd: run.turns > 0 ? run.costUsd : null,
        tokens: emptyTokenUsage(),
        turns: run.turns,
      };
    });
    chats.push({
      record: {
        id,
        name: last.name,
        cwd: last.cwd,
        workingDir: last.workingDir ?? null,
        origin: last.internal ? 'internal' : last.orchestrationId ? 'orchestration' : 'agentry',
        orchestrationId: last.orchestrationId,
        orchestrationTaskId: last.orchestrationTaskId,
        derivedFrom: null,
        prompt: first.prompt,
        lastText: last.lastText,
        model: last.model,
        permissionMode: last.permissionMode,
        account: last.account,
        permissionPrompts: last.permissionPrompts === 'host' ? 'host' : 'none',
        createdAt: first.createdAt,
        updatedAt: last.updatedAt,
      },
      executions,
    });
  }
  return { chats, chatOf };
}
