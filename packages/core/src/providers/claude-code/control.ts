import type { PermissionDecision } from '@agentry/shared';
import type { SessionIO } from '../driver.ts';

/** A control request the CLI has not answered by then is not going to be answered */
const CONTROL_TIMEOUT_MS = 15_000;

/** A person's decision in the shape `can_use_tool` expects; allowing always carries the input. */
function toControlDecision(decision: PermissionDecision, input: Record<string, unknown>): Record<string, unknown> {
  if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message ?? 'denied' };
  return {
    behavior: 'allow',
    updatedInput: decision.updatedInput ?? input,
    ...(decision.updatedPermissions?.length ? { updatedPermissions: decision.updatedPermissions } : {}),
  };
}

/**
 * The control protocol of one process: requests Agentry sends down stdin and waits on
 * (`interrupt`, `set_permission_mode`, `set_model`), and the CLI's own (`can_use_tool`), which it
 * holds until they are answered.
 */
export class ControlChannel {
  private seq = 0;
  /** Requests sent to the CLI, by request_id, waiting for its control_response */
  private readonly pending = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  /** The input each permission question was asked with: allowing it answers with that input unless changed */
  private readonly asked = new Map<string, Record<string, unknown>>();

  constructor(private readonly io: SessionIO) {}

  write(message: unknown): void {
    this.io.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends a control request down stdin and resolves with the CLI's response. */
  request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `agentry-${String(++this.seq)}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`the CLI did not answer ${String(request.subtype)} in time`));
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolvePromise(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ type: 'control_request', request_id: requestId, request });
    });
  }

  /** The CLI answered one of ours. */
  settle(response: Record<string, unknown>): void {
    const requestId = typeof response.request_id === 'string' ? response.request_id : null;
    const control = requestId ? this.pending.get(requestId) : undefined;
    if (!control || !requestId) return;
    this.pending.delete(requestId);
    if (response.subtype === 'error') control.reject(new Error(String(response.error ?? 'the CLI refused the request')));
    else control.resolve((response.response ?? {}) as Record<string, unknown>);
  }

  /** The CLI asks for something Agentry does not handle: an answer still has to come, or it waits for it. */
  refuse(requestId: string, subtype: unknown): void {
    this.write({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: `Agentry does not handle ${String(subtype)}` },
    });
  }

  /** Remembers what a `can_use_tool` request was about, for its answer. */
  ask(requestId: string, input: Record<string, unknown>): void {
    this.asked.set(requestId, input);
  }

  forget(requestId: string): void {
    this.asked.delete(requestId);
  }

  /** The answer goes to the process that asked, and nobody is waiting for it once that is gone. */
  answer(requestId: string, decision: PermissionDecision): void {
    const input = this.asked.get(requestId) ?? {};
    this.asked.delete(requestId);
    if (!this.io.up()) return;
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: toControlDecision(decision, input) },
    });
  }

  dispose(reason: string): void {
    for (const control of this.pending.values()) control.reject(new Error(reason));
    this.pending.clear();
    this.asked.clear();
  }
}
