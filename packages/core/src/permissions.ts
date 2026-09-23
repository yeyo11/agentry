import { EventEmitter } from 'node:events';
import type { PermissionDecision, PermissionRequest } from '@agentry/shared';

/** Long enough for someone to read the request and decide; a browser tab is not always in front. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  request: PermissionRequest;
  settle: (decision: PermissionDecision | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds what the CLI asks a person until someone answers it from the panel.
 *
 * The runner hands over each `can_use_tool` control request the CLI writes to stdout and writes the
 * decision back to its stdin, so nothing here knows about processes. A request waits until someone
 * answers it or it times out — denying is the only safe default, since a prompt nobody saw must not
 * become an approval.
 */
export class PermissionBroker extends EventEmitter {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    super();
  }

  /**
   * Registers a request and resolves with the decision, or with null when the CLI withdrew the
   * question itself (an interrupt): there is nobody left to send an answer to.
   */
  ask(request: PermissionRequest): Promise<PermissionDecision | null> {
    return new Promise((resolve) => {
      const settle = (decision: PermissionDecision | null) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(request.id);
        this.emit('resolved', request, decision);
        resolve(decision);
      };
      const timer = setTimeout(() => {
        settle({ behavior: 'deny', message: 'nobody answered the permission request in time' });
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(request.id, { request, settle, timer });
      this.emit('requested', request);
    });
  }

  /** Requests still waiting for an answer, oldest first; for one run when given an id. */
  list(runId?: string): PermissionRequest[] {
    const all = [...this.pending.values()].map((p) => p.request);
    return runId ? all.filter((r) => r.runId === runId) : all;
  }

  /**
   * Answers one waiting request. Given a `runId`, only that run's own requests can be answered:
   * an answer arrives addressed to a chat, and a request id alone would let any chat approve any
   * other chat's tool call. A request belonging to somebody else reads as missing, since saying
   * otherwise would confirm the id exists.
   */
  answer(id: string, decision: PermissionDecision, runId?: string): PermissionRequest {
    const entry = this.pending.get(id);
    if (!entry || (runId !== undefined && entry.request.runId !== runId)) {
      throw new Error('permission request not found; it may have timed out');
    }
    entry.settle(decision);
    return entry.request;
  }

  /** The CLI took the question back; it must disappear from the panel without an answer. */
  withdraw(id: string): void {
    this.pending.get(id)?.settle(null);
  }

  /** Denies everything still waiting for a run that is going away. */
  denyAllFor(runId: string, message = 'the run ended'): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.runId === runId) entry.settle({ behavior: 'deny', message });
    }
  }

  close(): void {
    for (const entry of [...this.pending.values()]) entry.settle({ behavior: 'deny', message: 'the wrapper is shutting down' });
  }
}
