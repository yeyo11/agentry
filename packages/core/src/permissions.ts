import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PermissionDecision, PermissionRequest } from '@agentry/shared';

/** Long enough for someone to read the request and decide; a browser tab is not always in front. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  request: PermissionRequest;
  settle: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * Answers the CLI's permission prompts with a human's decision.
 *
 * The CLI asks through an MCP tool, which runs as its own process, so the two halves talk over a
 * unix socket in the data dir: no port to discover and no token to leak, just filesystem
 * permissions. A request waits here until someone answers it or it times out — denying is the only
 * safe default, since a prompt nobody saw must not become an approval.
 */
export class PermissionBroker extends EventEmitter {
  readonly socketPath: string;
  private server: Server | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(dataDir: string) {
    super();
    this.socketPath = join(dataDir, 'permissions.sock');
  }

  /** Starts listening. Safe to call twice; a stale socket from a crash is replaced. */
  listen(): void {
    if (this.server) return;
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
    const server = createServer((socket) => this.handle(socket));
    server.on('error', () => {
      /* a broker that cannot listen simply never receives a request; runs still deny */
    });
    // Never a reason for this to keep the process alive: the API's own server does that, and a
    // test that only builds a Core would otherwise hang instead of exiting.
    server.unref();
    server.listen(this.socketPath, () => {
      // Only this user may answer prompts
      try {
        chmodSync(this.socketPath, 0o600);
      } catch {
        /* best effort */
      }
    });
    this.server = server;
  }

  private handle(socket: Socket): void {
    createInterface({ input: socket }).on('line', (line) => {
      let msg: { runId?: string; toolName?: string; toolUseId?: string; input?: Record<string, unknown> };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return socket.end(`${JSON.stringify({ behavior: 'deny', message: 'malformed permission request' })}\n`);
      }
      const request: PermissionRequest = {
        id: `perm-${String(++this.seq)}`,
        runId: msg.runId ?? '',
        toolName: msg.toolName ?? 'unknown',
        toolUseId: msg.toolUseId ?? '',
        input: msg.input ?? {},
        requestedAt: new Date().toISOString(),
      };
      void this.ask(request).then((decision) => {
        socket.end(`${JSON.stringify(decision)}\n`);
      });
    });
  }

  /** Registers a request and resolves once it is answered, or denies it when nobody does. */
  private ask(request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const settle = (decision: PermissionDecision) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(request.id);
        this.emit('resolved', request, decision);
        resolve(decision);
      };
      const timer = setTimeout(() => {
        settle({ behavior: 'deny', message: 'nobody answered the permission request in time' });
      }, DEFAULT_TIMEOUT_MS);
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

  answer(id: string, decision: PermissionDecision): PermissionRequest {
    const entry = this.pending.get(id);
    if (!entry) throw new Error('permission request not found; it may have timed out');
    entry.settle(decision);
    return entry.request;
  }

  /** Denies everything still waiting for a run that is going away. */
  denyAllFor(runId: string, message = 'the run ended'): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.runId === runId) entry.settle({ behavior: 'deny', message });
    }
  }

  close(): void {
    for (const entry of [...this.pending.values()]) entry.settle({ behavior: 'deny', message: 'the wrapper is shutting down' });
    this.server?.close();
    this.server = null;
    rmSync(this.socketPath, { force: true });
  }
}
